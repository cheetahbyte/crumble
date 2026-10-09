import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JobStore } from "../src/jobs.ts";

test("running jobs recover as explicitly resumable interruptions without replay", () => {
	const dir = mkdtempSync(join(tmpdir(), "crumble-jobs-"));
	const path = join(dir, "jobs.sqlite");
	try {
		let store = new JobStore(path);
		const running = store.create("demo", "change a file");
		const waiting = store.create("other", "ask a question");
		store.update(waiting.id, { status: "waiting", question: "which option?" });
		store.close();

		store = new JobStore(path);
		const recovered = store.recoverInterrupted();
		assert.equal(recovered.length, 1);
		assert.equal(recovered[0].id, running.id);
		assert.equal(recovered[0].status, "interrupted");
		assert.match(recovered[0].error ?? "", /Explicitly retry/);
		assert.equal(store.require(waiting.id).status, "waiting");
		assert.equal(store.pendingNotifications().length, 2);
		store.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("notifications persist, preserve each state change, and reject stale acknowledgements", () => {
	const dir = mkdtempSync(join(tmpdir(), "crumble-notifications-"));
	const path = join(dir, "jobs.sqlite");
	try {
		let store = new JobStore(path);
		const job = store.create("demo", "work");
		store.update(job.id, { status: "waiting", question: "which?" });
		store.close();

		store = new JobStore(path);
		store.update(job.id, { status: "running", question: null });
		store.update(job.id, { status: "done", summary: "finished" });
		const notifications = store.pendingNotifications();
		assert.deepEqual(notifications.map((entry) => entry.job.status), ["waiting", "done"]);
		assert.ok(notifications[0].version < notifications[1].version);
		assert.equal(store.acknowledgeNotification(job.id, notifications[0].version), true);
		assert.equal(store.acknowledgeNotification(job.id, notifications[0].version), false);
		assert.deepEqual(store.pendingNotifications().map((entry) => entry.job.status), ["done"]);
		store.close();

		store = new JobStore(path);
		assert.deepEqual(store.pendingNotifications().map((entry) => entry.job.status), ["done"]);
		assert.equal(store.acknowledgeNotification(job.id, notifications[1].version), true);
		assert.deepEqual(store.pendingNotifications(), []);
		store.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
