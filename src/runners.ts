import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Job } from "./jobs.ts";

export interface WorkerPaths {
	sessionDir: string;
	askExtension: string;
}

export interface WorkerRunner {
	paths(job: Job): WorkerPaths;
	spawn(job: Job, piArgs: string[]): ChildProcessWithoutNullStreams;
}

export interface RunnerDirs {
	jobsDir: string;
	workspacesDir: string;
	askExtension: string;
}

// Unsandboxed: the worker runs as a plain pi process on this machine with the host's Pi login.
export function hostRunner(dirs: RunnerDirs): WorkerRunner {
	return {
		paths: (job) => ({ sessionDir: join(dirs.jobsDir, job.id, "sessions"), askExtension: dirs.askExtension }),
		spawn(job, piArgs) {
			mkdirSync(join(dirs.jobsDir, job.id, "sessions"), { recursive: true });
			return spawn("pi", piArgs, { cwd: join(dirs.workspacesDir, job.project) });
		},
	};
}

export interface DockerOptions {
	image: string;
	// Names of host environment variables forwarded to the worker, such as a provider API key.
	envPassthrough: string[];
}

export function dockerRunner(dirs: RunnerDirs, options: DockerOptions): WorkerRunner {
	return {
		paths: () => ({ sessionDir: "/job/sessions", askExtension: "/opt/crumble/ask.ts" }),
		spawn(job, piArgs) {
			const jobDir = join(dirs.jobsDir, job.id);
			mkdirSync(join(jobDir, "sessions"), { recursive: true });
			mkdirSync(join(jobDir, "agent"), { recursive: true });
			const args = [
				"run",
				"--rm",
				"-i",
				"--name",
				`crumble-job-${job.id}`,
				"-v",
				`${join(dirs.workspacesDir, job.project)}:/workspace`,
				"-v",
				`${jobDir}:/job`,
				"-e",
				"PI_CODING_AGENT_DIR=/job/agent",
				"-e",
				"PI_SKIP_VERSION_CHECK=1",
				...options.envPassthrough.flatMap((name) => ["-e", name]),
				options.image,
				...piArgs,
			];
			return spawn("docker", args);
		},
	};
}
