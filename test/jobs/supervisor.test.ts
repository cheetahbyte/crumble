import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { type Job, JobStore } from "#jobs";
import type { WorkerRunner } from "../../src/jobs/runner.ts";
import { Supervisor } from "../../src/jobs/supervisor.ts";

const fakeWorker = join(import.meta.dirname, "..", "support", "fake-worker.ts");

function setup(options: { maxConcurrency?: number; timeoutMs?: number; spawnError?: boolean; onSettled?: (job: Job) => void } = {}) {
	const store = new JobStore(":memory:");
	const spawned: string[][] = [];
	const settled: Job[] = [];
	let wake: (() => void) | undefined;
	const runner: WorkerRunner = {
		sessionDir: () => "/sessions",
		spawn(_job, piArgs) {
			spawned.push(piArgs);
			if (options.spawnError) throw new Error("spawn failed");
			return spawn(process.execPath, [fakeWorker]);
		},
	};
	const supervisor = new Supervisor({
		store,
		runner,
		provider: "test-provider",
		model: "test-model",
		onSettled: (job) => {
			settled.push(job);
			wake?.();
			options.onSettled?.(job);
		},
		maxConcurrency: options.maxConcurrency,
		timeoutMs: options.timeoutMs,
	});
	const next = () => new Promise<Job>((resolve) => (wake = () => resolve(settled[settled.length - 1])));
	return { store, supervisor, spawned, next };
}

test("a job that finishes is stored as done with the worker's last text", async () => {
	const { supervisor, store, next } = setup();
	const settled = next();
	const job = supervisor.delegate("demo", "add a feature");
	assert.equal(job.status, "running");
	const done = await settled;
	assert.equal(done.status, "done");
	assert.equal(done.summary, "did: add a feature");
	assert.deepEqual(store.get(job.id), done);
});

test("a question parks the job, and the answer resumes the same session", async () => {
	const { supervisor, spawned, next } = setup();
	let settled = next();
	const job = supervisor.delegate("demo", "ask: which colour?");
	const parked = await settled;
	assert.equal(parked.status, "waiting");
	assert.equal(parked.question, "which colour?");

	settled = next();
	assert.equal(supervisor.message(job.id, "blue").status, "running");
	const done = await settled;
	assert.equal(done.status, "done");
	assert.equal(done.question, null);
	assert.equal(done.summary, "did: Answer to your question: blue");

	assert.equal(spawned.length, 2);
	for (const args of spawned) assert.equal(args[args.indexOf("--session-id") + 1], job.id);
});

test("a worker that exits mid-run fails the job and keeps its stderr", async () => {
	const { supervisor, next } = setup();
	const settled = next();
	supervisor.delegate("demo", "crash");
	const failed = await settled;
	assert.equal(failed.status, "failed");
	assert.match(failed.error ?? "", /exited before finishing/);
	assert.match(failed.error ?? "", /boom/);
});

test("a follow-up to a finished job resumes the same session", async () => {
	const { supervisor, spawned, next } = setup();
	let settled = next();
	const job = supervisor.delegate("demo", "add a feature");
	await settled;

	settled = next();
	assert.equal(supervisor.message(job.id, "use JavaScript").status, "running");
	const done = await settled;
	assert.equal(done.status, "done");
	assert.equal(done.summary, "did: use JavaScript");

	assert.equal(spawned.length, 2);
	for (const args of spawned) assert.equal(args[args.indexOf("--session-id") + 1], job.id);
});

test("messaging a job that is still running is rejected", async () => {
	const { supervisor, next } = setup();
	const settled = next();
	const job = supervisor.delegate("demo", "add a feature");
	assert.throws(() => supervisor.message(job.id, "blue"), /still running/);
	await settled;
});

test("full UUID job IDs are used as Pi session IDs", async () => {
	const { supervisor, spawned, next } = setup();
	const settled = next();
	const job = supervisor.delegate("demo", "add a feature");
	await settled;
	assert.match(job.id, /^[0-9a-f]{8}-[0-9a-f-]{27}$/i);
	assert.equal(spawned[0][spawned[0].indexOf("--session-id") + 1], job.id);
});

test("projects cannot have overlapping writes and capacity is bounded", async () => {
	const { supervisor } = setup({ maxConcurrency: 1 });
	const first = supervisor.delegate("demo", "hang");
	assert.throws(() => supervisor.delegate("demo", "second"), /already has a running job/);
	assert.throws(() => supervisor.delegate("other", "second"), /capacity is full/);
	await supervisor.cancel(first.id);
	await supervisor.close();
});

test("cancel stops a worker and permits an explicit retry in the same session", async () => {
	const { supervisor, next, spawned } = setup();
	const cancelledWait = next();
	const job = supervisor.delegate("demo", "hang");
	await new Promise((resolve) => setTimeout(resolve, 50));
	supervisor.cancel(job.id);
	const cancelled = await cancelledWait;
	assert.equal(cancelled.status, "cancelled");
	const retriedWait = next();
	supervisor.message(job.id, "do it now");
	assert.equal((await retriedWait).status, "done");
	assert.equal(spawned[0][spawned[0].indexOf("--session-id") + 1], spawned[1][spawned[1].indexOf("--session-id") + 1]);
	await supervisor.close();
});

test("graceful supervisor shutdown aborts the Pi session before marking the job interrupted", async () => {
	const { supervisor, store, next } = setup();
	const settled = next();
	const job = supervisor.delegate("demo", "hang");
	await new Promise((resolve) => setTimeout(resolve, 50));
	await supervisor.close();
	assert.equal((await settled).status, "interrupted");
	assert.equal(store.require(job.id).status, "interrupted");
});

test("execution timeout fails a hanging job", async () => {
	const { supervisor, next } = setup({ timeoutMs: 75 });
	const settled = next();
	supervisor.delegate("demo", "hang");
	const failed = await settled;
	assert.equal(failed.status, "failed");
	assert.match(failed.error ?? "", /timed out/);
	await supervisor.close();
});

test("spawn errors become failed jobs without an unhandled rejection", async () => {
	const { supervisor, next } = setup({ spawnError: true });
	const settled = next();
	const job = supervisor.delegate("demo", "work");
	assert.equal((await settled).status, "failed");
	assert.match(job.id, /-/);
	await supervisor.close();
});

test("settled callback errors do not rewrite a completed job as failed", async () => {
	const { supervisor, store, next } = setup({ onSettled: () => { throw new Error("wake failed"); } });
	const settled = next();
	const job = supervisor.delegate("demo", "work");
	await settled;
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(store.require(job.id).status, "done");
	await supervisor.close();
});
