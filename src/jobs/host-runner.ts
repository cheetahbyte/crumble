import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type { Job } from "./jobs.ts";
import { prepareSessionDir, resolveWorkspacePath, type RunnerDirs, type WorkerRunner, workerEnvironment } from "./runner.ts";
import { piCli } from "../shared/pi-command.ts";

// Unsandboxed: the worker's tools act directly on this machine.
export class HostRunner implements WorkerRunner {
	private readonly dirs: RunnerDirs;

	constructor(dirs: RunnerDirs) {
		this.dirs = dirs;
	}

	sessionDir(job: Job): string {
		return prepareSessionDir(this.dirs, job);
	}

	spawn(job: Job, piArgs: string[]): ChildProcessWithoutNullStreams {
		const workspace = resolveWorkspacePath(this.dirs, job.project);
		return spawn(process.execPath, [piCli, ...piArgs], { cwd: workspace, env: workerEnvironment(this.dirs) });
	}
}
