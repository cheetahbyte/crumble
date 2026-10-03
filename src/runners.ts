import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Job } from "./jobs.ts";

export interface WorkerRunner {
	sessionDir(job: Job): string;
	spawn(job: Job, piArgs: string[]): ChildProcessWithoutNullStreams;
}

export interface RunnerDirs {
	jobsDir: string;
	workspacesDir: string;
}

function prepareSessionDir(dirs: RunnerDirs, job: Job): string {
	const dir = join(dirs.jobsDir, job.id, "sessions");
	mkdirSync(dir, { recursive: true });
	return dir;
}

// Unsandboxed: the worker's tools act directly on this machine.
export function hostRunner(dirs: RunnerDirs): WorkerRunner {
	return {
		sessionDir: (job) => prepareSessionDir(dirs, job),
		spawn: (job, piArgs) => spawn("pi", piArgs, { cwd: join(dirs.workspacesDir, job.project) }),
	};
}

export interface SandboxOptions {
	image: string;
	sandboxExtension: string;
}

function ensureSandbox(name: string, workspace: string, image: string): void {
	let running = "";
	try {
		running = execFileSync("docker", ["inspect", "-f", "{{.State.Running}}", name], { stdio: ["ignore", "pipe", "ignore"] })
			.toString()
			.trim();
	} catch {
		// No container with this name yet.
	}
	if (running === "true") return;
	if (running === "false") execFileSync("docker", ["rm", name], { stdio: "ignore" });
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
			"-w",
			"/workspace",
			image,
			"sleep",
			"infinity",
		],
		{ stdio: "ignore" },
	);
}

// The worker's Pi process runs on the host with the host's Pi login; its file and shell tools
// run in one long-lived container per project.
export function sandboxRunner(dirs: RunnerDirs, options: SandboxOptions): WorkerRunner {
	return {
		sessionDir: (job) => prepareSessionDir(dirs, job),
		spawn(job, piArgs) {
			const workspace = join(dirs.workspacesDir, job.project);
			const container = `crumble-sandbox-${job.project}`;
			ensureSandbox(container, workspace, options.image);
			return spawn("pi", [...piArgs, "-e", options.sandboxExtension], {
				cwd: workspace,
				env: { ...process.env, CRUMBLE_SANDBOX_CONTAINER: container },
			});
		},
	};
}
