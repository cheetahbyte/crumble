import { createHash } from "node:crypto";
import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Job } from "./jobs.ts";
import { assertScopedPath, prepareSessionDir, resolveWorkspacePath, type RunnerDirs, type WorkerRunner, workerEnvironment } from "./runner.ts";
import { rejectSymlink } from "../shared/paths.ts";
import { piCliArgs } from "../shared/pi-command.ts";

const SANDBOX_EXTENSION = join(import.meta.dirname, "worker", "sandbox.ts");

export function containerName(dirs: RunnerDirs, workspace: string, project: string): string {
	const hash = createHash("sha256").update(resolve(workspace)).digest("hex").slice(0, 12);
	return `crumble-sandbox-${dirs.id}-${project}-${hash}`.slice(0, 120);
}

const SANDBOX_HOME = "/root";
const SANDBOX_PATH = `${SANDBOX_HOME}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;

/** One home directory per tenant, shared by all of its sandboxes, so installed tools and logins survive. */
export function resolveSandboxHome(dirs: RunnerDirs): string {
	rejectSymlink(dirs.rootDir, "Tenant directory");
	const home = join(dirs.rootDir, "sandbox-home");
	rejectSymlink(home, "Sandbox home directory");
	mkdirSync(home, { recursive: true, mode: 0o700 });
	return assertScopedPath(dirs.rootDir, home, "Sandbox home directory");
}

function ensureSandbox(name: string, workspace: string, home: string, image: string): void {
	let state = "";
	try {
		state = execFileSync("docker", ["inspect", "-f", `{{.State.Running}} {{range .Mounts}}{{if eq .Destination "${SANDBOX_HOME}"}}{{.Source}}{{end}}{{end}}`, name], { stdio: ["ignore", "pipe", "ignore"] })
			.toString()
			.trim();
	} catch {
		// No container with this name yet.
	}
	const [running, mountedHome] = [state.split(" ")[0], state.slice(state.indexOf(" ") + 1)];
	if (running === "true" && mountedHome === home) return;
	// Containers created before the shared home existed are replaced; workers do not survive a service restart anyway.
	if (state) execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
	execFileSync(
		"docker",
		[
			"run",
			"-d",
			"--name",
			name,
			"--cap-drop",
			"ALL",
			"--security-opt",
			"no-new-privileges",
			"--pids-limit",
			"512",
			"-v",
			`${workspace}:/workspace`,
			"-v",
			`${home}:${SANDBOX_HOME}`,
			"-e",
			`HOME=${SANDBOX_HOME}`,
			"-e",
			`NPM_CONFIG_PREFIX=${SANDBOX_HOME}/.local`,
			"-e",
			`PATH=${SANDBOX_PATH}`,
			"-w",
			"/workspace",
			image,
			"sleep",
			"infinity",
		],
		{ stdio: "ignore" },
	);
}

// The worker's Pi process runs on the host with the tenant's Pi config; file and shell tools
// run in one long-lived container per tenant and full workspace path, sharing the tenant's sandbox home.
export class SandboxRunner implements WorkerRunner {
	private readonly dirs: RunnerDirs;
	private readonly image: string;

	constructor(dirs: RunnerDirs, image: string) {
		this.dirs = dirs;
		this.image = image;
	}

	sessionDir(job: Job): string {
		return prepareSessionDir(this.dirs, job);
	}

	spawn(job: Job, piArgs: string[]): ChildProcessWithoutNullStreams {
		const workspace = resolveWorkspacePath(this.dirs, job.project);
		const container = containerName(this.dirs, workspace, job.project);
		ensureSandbox(container, workspace, resolveSandboxHome(this.dirs), this.image);
		const env = workerEnvironment(this.dirs, { CRUMBLE_SANDBOX_CONTAINER: container });
		return spawn(process.execPath, [...piCliArgs, ...piArgs, "-e", SANDBOX_EXTENSION], { cwd: workspace, env });
	}
}
