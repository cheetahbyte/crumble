import { createHash } from "node:crypto";
import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Job } from "./jobs.ts";
import { isWithin, rejectSymlink, SLUG } from "./paths.ts";
import { piCli } from "./pi-command.ts";
import { type TenantConfig, tenantEnvironment } from "./tenants.ts";

export interface WorkerRunner {
	sessionDir(job: Job): string;
	spawn(job: Job, piArgs: string[]): ChildProcessWithoutNullStreams;
}

export type RunnerDirs = Pick<TenantConfig, "id" | "rootDir" | "homeDir" | "agentDir" | "jobsDir" | "workspacesDir">;

function assertScopedPath(root: string, path: string, label: string): string {
	const actual = realpathSync(path);
	if (!isWithin(realpathSync(root), actual)) throw new Error(`${label} resolves outside the tenant directory`);
	return actual;
}

export function resolveWorkspacePath(dirs: Pick<RunnerDirs, "rootDir" | "workspacesDir">, project: string): string {
	if (!SLUG.test(project)) throw new Error(`Invalid project name ${JSON.stringify(project)}: use a lowercase slug`);
	rejectSymlink(dirs.rootDir, "Tenant directory");
	rejectSymlink(dirs.workspacesDir, "Tenant workspaces directory");
	mkdirSync(dirs.workspacesDir, { recursive: true, mode: 0o700 });
	const workspaces = assertScopedPath(dirs.rootDir, dirs.workspacesDir, "Workspace directory");
	const workspace = resolve(workspaces, project);
	rejectSymlink(workspace, "Project workspace");
	mkdirSync(workspace, { recursive: true, mode: 0o700 });
	const actual = assertScopedPath(dirs.rootDir, workspace, "Project workspace");
	if (!isWithin(workspaces, actual)) throw new Error("Project workspace resolves outside the tenant workspaces directory");
	return actual;
}

function prepareSessionDir(dirs: RunnerDirs, job: Job): string {
	if (!SLUG.test(job.id)) throw new Error(`Invalid job id ${JSON.stringify(job.id)}`);
	rejectSymlink(dirs.rootDir, "Tenant directory");
	rejectSymlink(dirs.jobsDir, "Tenant jobs directory");
	mkdirSync(dirs.jobsDir, { recursive: true, mode: 0o700 });
	assertScopedPath(dirs.rootDir, dirs.jobsDir, "Jobs directory");
	const jobDir = join(dirs.jobsDir, job.id);
	rejectSymlink(jobDir, "Job directory");
	const dir = join(jobDir, "sessions");
	rejectSymlink(dir, "Job session directory");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const actual = assertScopedPath(dirs.rootDir, dir, "Job session directory");
	if (!isWithin(realpathSync(dirs.jobsDir), actual)) throw new Error("Job session directory resolves outside the tenant jobs directory");
	return actual;
}

/** Pass only execution essentials and tenant-local Pi/HOME locations to workers. */
export function workerEnvironment(dirs: RunnerDirs, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	return { ...tenantEnvironment(dirs), ...extra };
}

// Unsandboxed: the worker's tools act directly on this machine.
export function hostRunner(dirs: RunnerDirs): WorkerRunner {
	return {
		sessionDir: (job) => prepareSessionDir(dirs, job),
		spawn(job, piArgs) {
			const workspace = resolveWorkspacePath(dirs, job.project);
			return spawn(process.execPath, [piCli, ...piArgs], { cwd: workspace, env: workerEnvironment(dirs) });
		},
	};
}

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
export function sandboxRunner(dirs: RunnerDirs, image: string): WorkerRunner {
	return {
		sessionDir: (job) => prepareSessionDir(dirs, job),
		spawn(job, piArgs) {
			const workspace = resolveWorkspacePath(dirs, job.project);
			const container = containerName(dirs, workspace, job.project);
			ensureSandbox(container, workspace, resolveSandboxHome(dirs), image);
			const env = workerEnvironment(dirs, { CRUMBLE_SANDBOX_CONTAINER: container });
			return spawn(process.execPath, [piCli, ...piArgs, "-e", SANDBOX_EXTENSION], { cwd: workspace, env });
		},
	};
}
