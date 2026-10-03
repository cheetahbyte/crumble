import type { Job, JobStore } from "./jobs.ts";
import { PiRpc } from "./rpc.ts";
import type { WorkerRunner } from "./runners.ts";

const WORKER_PROMPT = [
	"You are a worker agent. A task was delegated to you by an orchestrator acting for a person; nobody is watching you work.",
	"When the brief leaves a decision open that depends on the person's preference, or tells you to ask, call the ask tool instead of guessing.",
	"Facts you can find in the workspace are yours to look up; do not ask about them.",
	"When the task is finished, end with a short summary: what you changed, how you verified it, and anything you were unsure about.",
].join("\n");

export interface SupervisorOptions {
	store: JobStore;
	runner: WorkerRunner;
	provider: string;
	model: string;
	onSettled: (job: Job) => void;
}

export class Supervisor {
	private options: SupervisorOptions;

	constructor(options: SupervisorOptions) {
		this.options = options;
	}

	delegate(project: string, brief: string): Job {
		const job = this.options.store.create(project, brief);
		void this.run(job, brief);
		return job;
	}

	answer(jobId: string, answer: string): Job {
		const job = this.options.store.require(jobId);
		if (job.status !== "waiting") throw new Error(`Job ${jobId} is ${job.status}, not waiting for an answer`);
		const resumed = this.options.store.update(jobId, { status: "running", question: null });
		void this.run(resumed, `Answer to your question: ${answer}`);
		return resumed;
	}

	private async run(job: Job, message: string): Promise<void> {
		const { store, runner, provider, model, onSettled } = this.options;
		const paths = runner.paths(job);
		// --session-id creates the session on the first run and reopens it on every resume.
		const rpc = new PiRpc(
			runner.spawn(job, [
				"--mode",
				"rpc",
				"--session-id",
				job.id,
				"--session-dir",
				paths.sessionDir,
				"--provider",
				provider,
				"--model",
				model,
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--no-approve",
				"-e",
				paths.askExtension,
				"--append-system-prompt",
				WORKER_PROMPT,
			]),
		);
		try {
			let question: string | null = null;
			const settled = new Promise<"settled">((resolve) => {
				rpc.onEvent((event) => {
					if (event.type === "tool_execution_start" && event.toolName === "ask") {
						const args = event.args as { question?: unknown };
						question = typeof args.question === "string" ? args.question : null;
					}
					if (event.type === "agent_settled") resolve("settled");
				});
			});
			await rpc.request({ type: "prompt", message });
			const outcome = await Promise.race([settled, rpc.exited.then(() => "exited" as const)]);
			if (outcome === "exited") throw new Error("worker exited before finishing its run");
			const last = (await rpc.request({ type: "get_last_assistant_text" })) as { text: string | null };
			await rpc.close();
			if (question !== null) onSettled(store.update(job.id, { status: "waiting", question }));
			else if (last.text === null) throw new Error("worker finished without a result");
			else onSettled(store.update(job.id, { status: "done", summary: last.text }));
		} catch (error) {
			await rpc.close();
			const reason = error instanceof Error ? error.message : String(error);
			const detail = rpc.stderr.trim();
			onSettled(store.update(job.id, { status: "failed", error: detail ? `${reason}\n${detail}` : reason }));
		}
	}
}
