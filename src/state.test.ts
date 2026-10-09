import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { LearningStore } from "./learning.ts";
import { AssistantState } from "./state.ts";
import { openDatabase } from "./db/database.ts";

function withState(run: (state: AssistantState, directory: string) => void): void {
	const directory = mkdtempSync(join(tmpdir(), "crumble-state-"));
	const stateDb = openDatabase(join(directory, "assistant.db"), "assistant");
	const state = new AssistantState(stateDb);
	try {
		run(state, directory);
	} finally {
		stateDb.close();
		rmSync(directory, { recursive: true, force: true });
	}
}

test("memory persists in its tenant database and tenant databases are isolated", () => {
	const directory = mkdtempSync(join(tmpdir(), "crumble-tenants-"));
	const aliceDb = openDatabase(join(directory, "alice.db"), "assistant");
	const alice = new LearningStore(aliceDb);
	const bobDb = openDatabase(join(directory, "bob.db"), "assistant");
	const bob = new LearningStore(bobDb);
	try {
		alice.setMemory("preference", { concise: true });
		assert.deepEqual(alice.getMemory("preference"), { concise: true });
		assert.equal(bob.getMemory("preference"), undefined);
		assert.deepEqual(alice.listMemory()[0]?.key, "preference");
		assert.equal(alice.deleteMemory("preference"), true);
		assert.equal(alice.deleteMemory("preference"), false);
	} finally {
		aliceDb.close();
		bobDb.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("inbox deduplicates stable IDs and recovers processing requests without replay", () => {
	withState((state) => {
		assert.equal(state.enqueue({ id: "discord:42", text: "do work", source: "discord" }), true);
		assert.equal(state.enqueue({ id: "discord:42", text: "duplicate", source: "discord" }), false);
		assert.equal(state.nextPending()?.text, "do work");
		assert.equal(state.markProcessing("discord:42"), true);
		assert.equal(state.markProcessing("discord:42"), false);
		const recovered = state.recoverInterrupted();
		assert.equal(recovered.length, 1);
		assert.equal(recovered[0]?.status, "failed");
		assert.match(recovered[0]?.response ?? "", /not replayed automatically/);
		assert.equal(state.nextPending(), undefined);
		assert.deepEqual(state.pendingDeliveries(), [{
			id: "discord:42",
			response: "Request was interrupted when the application stopped. It was not replayed automatically.",
			source: "discord",
			status: "failed",
		}]);
	});
});

test("inbox claims and outbox deliveries preserve insertion order for equal timestamps", () => {
	const originalNow = Date.now;
	Date.now = () => 1_700_000_000_000;
	try {
		withState((state) => {
			for (const id of ["z", "y", "x"]) {
				assert.equal(state.enqueue({ id, text: `request ${id}`, source: "internal" }), true);
			}

			const claimed: string[] = [];
			for (let i = 0; i < 3; i++) {
				const request = state.nextPending();
				assert.ok(request);
				claimed.push(request.id);
				assert.equal(state.markProcessing(request.id), true);
				assert.equal(state.complete(request.id, `response ${request.id}`), true);
			}

			assert.deepEqual(claimed, ["z", "y", "x"]);
			assert.deepEqual(state.pendingDeliveries().map(({ id }) => id), ["z", "y", "x"]);
		});
	} finally {
		Date.now = originalNow;
	}
});

test("completed output is durable until acknowledged", () => {
	const directory = mkdtempSync(join(tmpdir(), "crumble-outbox-"));
	const path = join(directory, "assistant.db");
	let stateDb = openDatabase(path, "assistant");
	let state = new AssistantState(stateDb);
	try {
		state.enqueue({ id: "terminal:1", text: "hello", source: "terminal" });
		state.markProcessing("terminal:1");
		assert.equal(state.complete("terminal:1", "hello back"), true);
		stateDb.close();
		stateDb = openDatabase(path, "assistant");
		state = new AssistantState(stateDb);
		assert.deepEqual(state.pendingDeliveries(), [{ id: "terminal:1", response: "hello back", source: "terminal", status: "completed" }]);
		assert.equal(state.acknowledgeDelivery("terminal:1"), true);
		assert.equal(state.acknowledgeDelivery("terminal:1"), false);
		assert.deepEqual(state.pendingDeliveries(), []);
	} finally {
		stateDb.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("schedules persist, fire only once, and cancel cleanly", () => {
	const directory = mkdtempSync(join(tmpdir(), "crumble-schedules-"));
	const path = join(directory, "assistant.db");
	let stateDb = openDatabase(path, "assistant");
	let state = new AssistantState(stateDb);
	try {
		const schedule = state.createSchedule({ id: "once", label: "Later", prompt: "do something", dueAt: 100_000, source: "internal" });
		assert.equal(schedule.enabled, true);
		stateDb.close();
		stateDb = openDatabase(path, "assistant");
		state = new AssistantState(stateDb);
		assert.equal(state.listSchedules()[0]?.id, "once");
		assert.equal(state.enqueueDueSchedules(99_999), 0);
		assert.equal(state.enqueueDueSchedules(100_000), 1);
		assert.equal(state.enqueueDueSchedules(200_000), 0);
		assert.equal(state.listSchedules()[0]?.enabled, false);
		assert.equal(state.nextPending()?.text, "do something");

		state.createSchedule({ id: "cancel-me", label: "Cancel", prompt: "noop", dueAt: 1, source: "terminal" });
		assert.equal(state.cancelSchedule("cancel-me"), true);
		assert.equal(state.enqueueDueSchedules(1_000_000), 0);
	} finally {
		stateDb.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("missed interval periods coalesce into one event and advance beyond now", () => {
	withState((state) => {
		state.createSchedule({ id: "repeat", label: "Repeat", prompt: "check in", dueAt: 100_000, intervalMs: 60_000, source: "terminal" });
		assert.equal(state.enqueueDueSchedules(1_000_000), 1);
		assert.equal(state.enqueueDueSchedules(1_000_000), 0);
		const schedule = state.listSchedules()[0];
		assert.ok(schedule);
		assert.ok(schedule.dueAt > 1_000_000);
		assert.equal(state.nextPending()?.text, "check in");
	});
});

test("parent and worker connections share a single atomic claim and durable delivery", () => {
	const directory = mkdtempSync(join(tmpdir(), "crumble-shared-state-"));
	const path = join(directory, "assistant.db");
	const parentDb = openDatabase(path, "assistant");
	const parent = new AssistantState(parentDb);
	const workerDb = openDatabase(path, "assistant");
	const worker = new AssistantState(workerDb);
	try {
		assert.equal(parent.enqueue({ id: "discord:shared", text: "handle this", source: "discord" }), true);
		assert.equal(parent.nextPending()?.id, "discord:shared");
		assert.equal(worker.nextPending()?.id, "discord:shared");
		assert.equal(worker.markProcessing("discord:shared"), true);
		assert.equal(parent.markProcessing("discord:shared"), false);

		new LearningStore(workerDb).setMemory("learned", "kept in the same tenant");
		assert.equal(new LearningStore(parentDb).getMemory("learned"), "kept in the same tenant");
		const longResponse = "x".repeat(50_000);
		assert.equal(worker.complete("discord:shared", longResponse), true);
		assert.equal(parent.pendingDeliveries()[0]?.response.length, longResponse.length);
		assert.equal(parent.acknowledgeDelivery("discord:shared"), true);
		assert.deepEqual(worker.pendingDeliveries(), []);
	} finally {
		parentDb.close();
		workerDb.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("two connections coalesce a due schedule into one inbox request", () => {
	const directory = mkdtempSync(join(tmpdir(), "crumble-shared-schedule-"));
	const path = join(directory, "assistant.db");
	const parentDb = openDatabase(path, "assistant");
	const parent = new AssistantState(parentDb);
	const workerDb = openDatabase(path, "assistant");
	const worker = new AssistantState(workerDb);
	try {
		parent.createSchedule({ id: "shared-once", label: "Shared", prompt: "wake up", dueAt: 10_000, source: "internal" });
		assert.equal(worker.enqueueDueSchedules(10_000), 1);
		assert.equal(parent.enqueueDueSchedules(10_000), 0);
		assert.equal(parent.nextPending()?.text, "wake up");
	} finally {
		parentDb.close();
		workerDb.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("timezone cron schedules follow wall-clock time across both DST changes", () => {
	withState((state) => {
		const spring = state.createSchedule({
			id: "spring", label: "Spring", prompt: "check", cron: "30 2 * * *", timezone: "Europe/Berlin",
			dueAt: Date.parse("2026-03-28T01:30:00Z"), source: "internal",
		});
		assert.equal(state.enqueueDueSchedules(spring.dueAt), 1);
		assert.equal(state.listSchedules().find(({ id }) => id === "spring")?.dueAt, Date.parse("2026-03-29T01:30:00Z"));

		const fall = state.createSchedule({
			id: "fall", label: "Fall", prompt: "check", cron: "30 2 * * *", timezone: "Europe/Berlin",
			dueAt: Date.parse("2026-10-25T00:30:00Z"), source: "internal",
		});
		assert.equal(state.enqueueDueSchedules(fall.dueAt), 1);
		assert.equal(state.listSchedules().find(({ id }) => id === "fall")?.dueAt, Date.parse("2026-10-26T01:30:00Z"));
	});
});

test("paused and manual routines persist and duplicate pending or running executions are coalesced", () => {
	const directory = mkdtempSync(join(tmpdir(), "crumble-routine-controls-"));
	const path = join(directory, "assistant.db");
	let stateDb = openDatabase(path, "assistant");
	let state = new AssistantState(stateDb);
	try {
		state.createSchedule({ id: "routine", label: "Routine", prompt: "check", cron: "* * * * *", timezone: "UTC", dueAt: 1_000, source: "internal" });
		assert.equal(state.pauseSchedule("routine"), true);
		assert.equal(state.enqueueDueSchedules(120_000), 0);
		stateDb.close();
		stateDb = openDatabase(path, "assistant");
		state = new AssistantState(stateDb);
		assert.equal(state.getSchedule("routine")?.paused, true);
		assert.equal(state.resumeSchedule("routine"), true);
		assert.equal(state.enqueueDueSchedules(120_000), 1);
		const queued = state.nextPending();
		assert.ok(queued);
		assert.equal(queued.scheduleId, "routine");
		assert.equal(state.enqueueDueSchedules(180_000), 0);
		assert.equal(state.runScheduleNow("routine"), false);
		assert.equal(state.markProcessing(queued.id), true);
		assert.equal(state.enqueueDueSchedules(240_000), 0);
		assert.equal(state.runScheduleNow("routine"), false);
		assert.equal(state.complete(queued.id, "same result"), true);
		assert.equal(state.runScheduleNow("routine"), true);
		assert.equal(state.runScheduleNow("routine"), false);
		assert.equal(state.nextPending()?.scheduleId, "routine");
	} finally {
		stateDb.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("changes_only suppresses unchanged and explicitly quiet results while preserving the latest result", () => {
	withState((state) => {
		state.createSchedule({ id: "watch", label: "Watch", prompt: "check", dueAt: 1_000, source: "internal", notificationPolicy: "changes_only" });
		assert.equal(state.runScheduleNow("watch"), true);
		const first = state.nextPending();
		assert.ok(first);
		assert.equal(state.markProcessing(first.id), true);
		assert.equal(state.complete(first.id, "unchanged baseline", false), true);
		assert.deepEqual(state.pendingDeliveries(), []);
		assert.equal(state.getSchedule("watch")?.lastResult, "unchanged baseline");
		assert.equal(state.runScheduleNow("watch"), true);
		const second = state.nextPending();
		assert.ok(second);
		assert.equal(state.markProcessing(second.id), true);
		assert.equal(state.complete(second.id, "unchanged baseline"), true);
		assert.deepEqual(state.pendingDeliveries(), []);
		assert.equal(state.runScheduleNow("watch"), true);
		const third = state.nextPending();
		assert.ok(third);
		assert.equal(state.markProcessing(third.id), true);
		assert.equal(state.complete(third.id, "meaningful update"), true);
		assert.equal(state.pendingDeliveries()[0]?.response, "meaningful update");
		assert.equal(state.getSchedule("watch")?.lastNotifiedResult, "meaningful update");
	});
});

test("legacy schedule and inbox databases migrate with notification defaults preserving schedules", () => {
	const directory = mkdtempSync(join(tmpdir(), "crumble-legacy-db-"));
	const path = join(directory, "assistant.db");
	const legacy = new DatabaseSync(path);
	legacy.exec(`
		CREATE TABLE assistant_inbox (id TEXT PRIMARY KEY, text TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL, response TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
		CREATE TABLE assistant_schedules (id TEXT PRIMARY KEY, label TEXT NOT NULL, prompt TEXT NOT NULL, due_at INTEGER NOT NULL, interval_ms INTEGER, source TEXT NOT NULL, enabled INTEGER NOT NULL, created_at INTEGER NOT NULL);
		INSERT INTO assistant_schedules VALUES ('old', 'Old routine', 'keep me', 12345, 60000, 'terminal', 1, 7);
	`);
	legacy.close();
	const stateDb = openDatabase(path, "assistant");
	const state = new AssistantState(stateDb);
	try {
		assert.deepEqual(state.getSchedule("old"), {
			id: "old", label: "Old routine", prompt: "keep me", dueAt: 12345, intervalMs: 60000,
			source: "terminal", enabled: true, createdAt: 7, cron: null, timezone: "UTC",
			notificationPolicy: "always", lastResult: null, lastNotifiedResult: null, paused: false,
		});
		assert.equal(state.enqueueDueSchedules(12345), 1);
		assert.equal(state.nextPending()?.scheduleId, "old");
	} finally {
		stateDb.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
