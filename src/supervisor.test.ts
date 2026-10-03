import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { type Job, JobStore } from "./jobs.ts";
import type { WorkerRunner } from "./runners.ts";
import { Supervisor } from "./supervisor.ts";

const fakeWorker = join(import.meta.dirname, "testing", "fake-worker.ts");

function setup() {
	const store = new JobStore(":memory:");
	const spawned: string[][] = [];
	const settled: Job[] = [];
	let wake: (() => void) | undefined;
	const runner: WorkerRunner = {
		sessionDir: () => "/sessions",
		spawn(_job, piArgs) {
			spawned.push(piArgs);
			return spawn(process.execPath, [fakeWorker]);
		},
	};
	const supervisor = new Supervisor({
		store,
		runner,
		askExtension: "/ask.ts",
		provider: "test-provider",
		model: "test-model",
		onSettled: (job) => {
			settled.push(job);
			wake?.();
		},
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
	assert.equal(supervisor.answer(job.id, "blue").status, "running");
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

test("answering a job that is not waiting is rejected", async () => {
	const { supervisor, next } = setup();
	const settled = next();
	const job = supervisor.delegate("demo", "add a feature");
	await settled;
	assert.throws(() => supervisor.answer(job.id, "blue"), /not waiting/);
});
