import { join } from "node:path";
import { hostRunner, type RunnerDirs, sandboxRunner, type WorkerRunner } from "./runners.ts";

const root = join(import.meta.dirname, "..");

export const config = {
	dataDir: join(root, "data"),
	jobsDir: join(root, "data", "jobs"),
	workspacesDir: join(root, "workspaces"),
	provider: "openai-codex",
	model: "gpt-6-luna",
	sandboxImage: "crumble-sandbox",
	askExtension: join(root, "src", "worker", "ask.ts"),
};

export function createRunner(): WorkerRunner {
	const dirs: RunnerDirs = { jobsDir: config.jobsDir, workspacesDir: config.workspacesDir };
	const kind = process.env.CRUMBLE_RUNNER ?? "sandbox";
	if (kind === "host") return hostRunner(dirs);
	if (kind !== "sandbox") throw new Error(`CRUMBLE_RUNNER must be "sandbox" or "host", got "${kind}"`);
	return sandboxRunner(dirs, {
		image: config.sandboxImage,
		sandboxExtension: join(root, "src", "worker", "sandbox.ts"),
	});
}
