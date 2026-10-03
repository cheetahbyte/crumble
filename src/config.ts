import { join } from "node:path";
import { dockerRunner, hostRunner, type RunnerDirs, type WorkerRunner } from "./runners.ts";

const root = join(import.meta.dirname, "..");

export const config = {
	dataDir: join(root, "data"),
	jobsDir: join(root, "data", "jobs"),
	workspacesDir: join(root, "workspaces"),
	provider: "openai-codex",
	model: "gpt-6-luna",
	workerImage: "crumble-worker",
};

export function createRunner(): WorkerRunner {
	const dirs: RunnerDirs = {
		jobsDir: config.jobsDir,
		workspacesDir: config.workspacesDir,
		askExtension: join(root, "src", "worker", "ask.ts"),
	};
	const kind = process.env.CRUMBLE_RUNNER ?? "docker";
	if (kind === "host") return hostRunner(dirs);
	if (kind !== "docker") throw new Error(`CRUMBLE_RUNNER must be "docker" or "host", got "${kind}"`);
	const envPassthrough = (process.env.CRUMBLE_WORKER_ENV ?? "").split(",").filter((name) => name.length > 0);
	if (envPassthrough.length === 0) {
		throw new Error(
			"The Docker worker has no model credential. Set CRUMBLE_WORKER_ENV to the name of a provider key variable " +
				"(for example OPENAI_API_KEY), or set CRUMBLE_RUNNER=host to run workers unsandboxed with the host's Pi login.",
		);
	}
	return dockerRunner(dirs, { image: config.workerImage, envPassthrough });
}
