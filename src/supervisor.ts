import { join } from "node:path";
import type { Job, JobPatch, JobStore } from "./jobs.ts";
import { PiRpc } from "./rpc.ts";
import type { WorkerRunner } from "./runners.ts";

const WORKER_PROMPT = [
	"You are a worker agent. A task was delegated to you by an orchestrator acting for a person; nobody is watching you work.",
	"When the brief leaves a decision open that depends on the person's preference, or tells you to ask, call the ask tool instead of guessing.",
	"Facts you can find in the workspace are yours to look up; do not ask about them.",
	"Each bash invocation is cleaned up when that command ends, including background processes. Do not start a server in one command and expect it to survive into another; start temporary servers and run dependent checks in the same bash command.",
	"Never put a question in your final message. If you need anything from the person before you can finish, call the ask tool; a final message means the task is finished.",
	"When the task is finished, end with a short summary: what you changed, how you verified it, and anything you were unsure about.",
].join("\n");

const ASK_EXTENSION = join(import.meta.dirname, "worker", "ask.ts");

export interface SupervisorOptions {
	store: JobStore;
	runner: WorkerRunner;
	provider: string;
	model: string;
	onSettled: (job: Job) => void;
	maxConcurrency?: number;
	timeoutMs?: number;
	closeGraceMs?: number;
	abortGraceMs?: number;
}

interface ActiveJob {
	kind: "cancelled" | "interrupted" | null;
	rpc?: PiRpc;
	task?: Promise<void>;
	stopSignal: Promise<void>;
	resolveStop: () => void;
	abortPromise?: Promise<boolean>;
}

const CANCELLED = "Cancelled by request.";
const INTERRUPTED = "Worker stopped because the application is shutting down. Explicitly retry to resume this Pi session.";

export class Supervisor {
	private options: SupervisorOptions;
	private active = new Map<string, ActiveJob>();
	private projects = new Set<string>();
	private tasks = new Set<Promise<void>>();
	private closing = false;

	constructor(options: SupervisorOptions) {
		this.options = options;
	}

	delegate(project: string, brief: string): Job {
		this.assertCanStart(project);
		const job = this.options.store.create(project, brief);
		this.start(job, brief);
		return job;
	}

	// Continues parked or completed work in its existing Pi session. Failed and cancelled jobs
	// are retried only after an explicit message from the person.
	message(jobId: string, text: string): Job {
		const job = this.options.store.require(jobId);
		if (job.status === "running") throw new Error(`Job ${jobId} is still running`);
		if (job.status === "interrupted" && text.trim().length === 0) {
			throw new Error("An explicit retry message is required to resume an interrupted job");
		}
		this.assertCanStart(job.project);
		const prompt = job.status === "waiting" ? `Answer to your question: ${text}` : text;
		const resumed = this.options.store.update(jobId, { status: "running", question: null, summary: null, error: null });
		this.start(resumed, prompt);
		return resumed;
	}

	async cancel(jobId: string): Promise<Job> {
		const job = this.options.store.require(jobId);
		if (job.status !== "running") throw new Error(`Job ${jobId} is not running`);
		const active = this.active.get(jobId);
		if (!active) {
			return this.settle(jobId, { status: "cancelled", error: CANCELLED });
		}
		if (active.kind === null) {
			active.kind = "cancelled";
			active.abortPromise = active.rpc ? this.requestAbort(active.rpc) : Promise.resolve(false);
			active.resolveStop();
		}
		await active.task;
		return this.options.store.require(jobId);
	}

	// Safe to call once at startup. No interrupted worker is replayed automatically.
	recoverInterrupted(): Job[] {
		return this.options.store.recoverInterrupted();
	}

	async close(): Promise<void> {
		if (!this.closing) {
			this.closing = true;
			for (const [jobId, active] of this.active) {
				if (active.kind !== null) continue;
				active.kind = "interrupted";
				active.abortPromise = active.rpc ? this.requestAbort(active.rpc) : Promise.resolve(false);
				active.resolveStop();
			}
		}
		await Promise.allSettled([...this.tasks]);
	}

	private assertCanStart(project: string): void {
		if (this.closing) throw new Error("Supervisor is shutting down");
		if (this.projects.has(project)) throw new Error(`Project ${project} already has a running job`);
		const max = this.options.maxConcurrency ?? 4;
		if (this.active.size >= max) throw new Error(`Worker capacity is full (${max} jobs)`);
	}

	private start(job: Job, message: string): void {
		let resolveStop!: () => void;
		const stopSignal = new Promise<void>((resolve) => (resolveStop = resolve));
		const active: ActiveJob = { kind: null, stopSignal, resolveStop };
		this.active.set(job.id, active);
		this.projects.add(job.project);
		const task = this.run(job, message, active).finally(() => {
			this.active.delete(job.id);
			this.projects.delete(job.project);
			this.tasks.delete(task);
		});
		active.task = task;
		this.tasks.add(task);
	}

	private async run(job: Job, message: string, active: ActiveJob): Promise<void> {
		const patch = active.kind === null ? await this.attempt(job, message, active) : undefined;
		this.settle(job.id, active.kind === null && patch ? patch : {
			status: active.kind ?? "interrupted",
			error: active.kind === "cancelled" ? CANCELLED : INTERRUPTED,
		});
	}

	/** Run one worker turn. A cancel or shutdown during the turn is applied by the caller. */
	private async attempt(job: Job, message: string, active: ActiveJob): Promise<JobPatch | undefined> {
		const { runner, provider, model, closeGraceMs } = this.options;
		let rpc: PiRpc | undefined;
		try {
			// --session-id creates the session on the first run and reopens it on every resume.
			rpc = new PiRpc(
				runner.spawn(job, [
					"--mode", "rpc",
					"--session-id", job.id,
					"--session-dir", runner.sessionDir(job),
					"--provider", provider,
					"--model", model,
					"--no-extensions", "--no-skills", "--no-prompt-templates", "--no-approve",
					"--tools", "read,bash,edit,write,ask",
					"-e", ASK_EXTENSION,
					"--append-system-prompt", WORKER_PROMPT,
				]),
				{ closeGraceMs },
			);
			active.rpc = rpc;
			const result = await Promise.race([this.complete(rpc, message), active.stopSignal.then(() => undefined)]);
			if (!result || active.kind !== null) {
				await this.finishStoppedWorker(rpc, active);
				return undefined;
			}
			await rpc.close(closeGraceMs);
			if (result.question !== null) return { status: "waiting", question: result.question, error: null };
			if (result.text === null) throw new Error("worker finished without a result");
			return { status: "done", summary: result.text, question: null, error: null };
		} catch (error) {
			if (rpc) await rpc.terminate(closeGraceMs ?? 1_000);
			const reason = error instanceof Error ? error.message : String(error);
			const detail = rpc?.stderr.trim();
			return { status: "failed", error: detail ? `${reason}\n${detail}` : reason };
		}
	}

	/** Prompt the worker and wait until it settles, asks a question, or times out. */
	private async complete(rpc: PiRpc, message: string): Promise<{ question: string | null; text: string | null }> {
		const timeoutMs = this.options.timeoutMs ?? 15 * 60_000;
		let question: string | null = null;
		let settledResolve!: () => void;
		const settled = new Promise<void>((resolve) => (settledResolve = resolve));
		rpc.onEvent((event) => {
			if (event.type === "tool_execution_start" && event.toolName === "ask") {
				const args = event.args as { question?: unknown };
				question = typeof args.question === "string" ? args.question : null;
			}
			if (event.type === "agent_settled") settledResolve();
		});
		const work = async () => {
			await rpc.request({ type: "prompt", message }, timeoutMs);
			const outcome = await Promise.race([
				settled.then(() => "settled" as const),
				rpc.exited.then(() => "exited" as const),
				rpc.failure.then((error) => error ?? new Promise<never>(() => {})),
			]);
			if (outcome === "exited") throw new Error("worker exited before finishing its run");
			if (outcome instanceof Error) throw outcome;
			const last = (await rpc.request({ type: "get_last_assistant_text" }, timeoutMs)) as { text: string | null };
			return { question, text: last.text };
		};
		let timer: NodeJS.Timeout | undefined;
		let timedOut = false;
		const deadline = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				timedOut = true;
				reject(new Error(`Worker timed out after ${timeoutMs} ms`));
			}, timeoutMs);
		});
		try {
			return await Promise.race([work(), deadline]);
		} catch (error) {
			if (timedOut && await this.requestAbort(rpc)) await rpc.close(this.options.closeGraceMs);
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}

	private requestAbort(rpc: PiRpc): Promise<boolean> {
		return rpc.request({ type: "abort" }, this.options.abortGraceMs ?? 5_000).then(
			() => true,
			() => false,
		);
	}

	private async finishStoppedWorker(rpc: PiRpc, active: ActiveJob): Promise<void> {
		const aborted = await (active.abortPromise ?? this.requestAbort(rpc));
		if (aborted) await rpc.close(this.options.closeGraceMs);
		else await rpc.terminate(this.options.closeGraceMs ?? 1_000);
	}

	private settle(jobId: string, patch: JobPatch): Job {
		const job = this.options.store.update(jobId, patch);
		if (job.status !== "running") {
			this.active.delete(jobId);
			this.projects.delete(job.project);
		}
		try {
			this.options.onSettled(job);
		} catch {
			// The callback is only a wake-up hint. Persisted notifications remain authoritative.
		}
		return job;
	}
}
