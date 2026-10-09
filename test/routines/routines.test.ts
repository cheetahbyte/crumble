import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Inbox } from "#inbox";
import { Routines } from "#routines";
import { openDatabase } from "#db/database";

function withRoutines(run: (inbox: Inbox, routines: Routines) => void): void {
	const directory = mkdtempSync(join(tmpdir(), "crumble-state-"));
	const stateDb = openDatabase(join(directory, "assistant.db"), "assistant");
	const inbox = new Inbox(stateDb);
	try {
		run(inbox, new Routines(stateDb, inbox));
	} finally {
		stateDb.close();
		rmSync(directory, { recursive: true, force: true });
	}
}

test("schedules persist, fire only once, and cancel cleanly", () => {
	const directory = mkdtempSync(join(tmpdir(), "crumble-schedules-"));
	const path = join(directory, "assistant.db");
	let stateDb = openDatabase(path, "assistant");
	let inbox = new Inbox(stateDb);
	let routines = new Routines(stateDb, inbox);
	try {
		const schedule = routines.createSchedule({ id: "once", label: "Later", prompt: "do something", dueAt: 100_000, source: "internal" });
		assert.equal(schedule.enabled, true);
		stateDb.close();
		stateDb = openDatabase(path, "assistant");
		inbox = new Inbox(stateDb);
		routines = new Routines(stateDb, inbox);
		assert.equal(routines.listSchedules()[0]?.id, "once");
		assert.equal(routines.enqueueDueSchedules(99_999), 0);
		assert.equal(routines.enqueueDueSchedules(100_000), 1);
		assert.equal(routines.enqueueDueSchedules(200_000), 0);
		assert.equal(routines.listSchedules()[0]?.enabled, false);
		assert.equal(inbox.nextPending()?.text, "do something");

		routines.createSchedule({ id: "cancel-me", label: "Cancel", prompt: "noop", dueAt: 1, source: "terminal" });
		assert.equal(routines.cancelSchedule("cancel-me"), true);
		assert.equal(routines.enqueueDueSchedules(1_000_000), 0);
	} finally {
		stateDb.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("missed interval periods coalesce into one event and advance beyond now", () => {
	withRoutines((inbox, routines) => {
		routines.createSchedule({ id: "repeat", label: "Repeat", prompt: "check in", dueAt: 100_000, intervalMs: 60_000, source: "terminal" });
		assert.equal(routines.enqueueDueSchedules(1_000_000), 1);
		assert.equal(routines.enqueueDueSchedules(1_000_000), 0);
		const schedule = routines.listSchedules()[0];
		assert.ok(schedule);
		assert.ok(schedule.dueAt > 1_000_000);
		assert.equal(inbox.nextPending()?.text, "check in");
	});
});

test("two connections coalesce a due schedule into one inbox request", () => {
	const directory = mkdtempSync(join(tmpdir(), "crumble-shared-schedule-"));
	const path = join(directory, "assistant.db");
	const parentDb = openDatabase(path, "assistant");
	const parent = new Inbox(parentDb);
	const parentRoutines = new Routines(parentDb, parent);
	const workerDb = openDatabase(path, "assistant");
	const worker = new Inbox(workerDb);
	const workerRoutines = new Routines(workerDb, worker);
	try {
		parentRoutines.createSchedule({ id: "shared-once", label: "Shared", prompt: "wake up", dueAt: 10_000, source: "internal" });
		assert.equal(workerRoutines.enqueueDueSchedules(10_000), 1);
		assert.equal(parentRoutines.enqueueDueSchedules(10_000), 0);
		assert.equal(parent.nextPending()?.text, "wake up");
	} finally {
		parentDb.close();
		workerDb.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("timezone cron schedules follow wall-clock time across both DST changes", () => {
	withRoutines((_inbox, routines) => {
		const spring = routines.createSchedule({
			id: "spring", label: "Spring", prompt: "check", cron: "30 2 * * *", timezone: "Europe/Berlin",
			dueAt: Date.parse("2026-03-28T01:30:00Z"), source: "internal",
		});
		assert.equal(routines.enqueueDueSchedules(spring.dueAt), 1);
		assert.equal(routines.listSchedules().find(({ id }) => id === "spring")?.dueAt, Date.parse("2026-03-29T01:30:00Z"));

		const fall = routines.createSchedule({
			id: "fall", label: "Fall", prompt: "check", cron: "30 2 * * *", timezone: "Europe/Berlin",
			dueAt: Date.parse("2026-10-25T00:30:00Z"), source: "internal",
		});
		assert.equal(routines.enqueueDueSchedules(fall.dueAt), 1);
		assert.equal(routines.listSchedules().find(({ id }) => id === "fall")?.dueAt, Date.parse("2026-10-26T01:30:00Z"));
	});
});

test("paused and manual routines persist and duplicate pending or running executions are coalesced", () => {
	const directory = mkdtempSync(join(tmpdir(), "crumble-routine-controls-"));
	const path = join(directory, "assistant.db");
	let stateDb = openDatabase(path, "assistant");
	let inbox = new Inbox(stateDb);
	let routines = new Routines(stateDb, inbox);
	try {
		routines.createSchedule({ id: "routine", label: "Routine", prompt: "check", cron: "* * * * *", timezone: "UTC", dueAt: 1_000, source: "internal" });
		assert.equal(routines.pauseSchedule("routine"), true);
		assert.equal(routines.enqueueDueSchedules(120_000), 0);
		stateDb.close();
		stateDb = openDatabase(path, "assistant");
		inbox = new Inbox(stateDb);
		routines = new Routines(stateDb, inbox);
		assert.equal(routines.getSchedule("routine")?.paused, true);
		assert.equal(routines.resumeSchedule("routine"), true);
		assert.equal(routines.enqueueDueSchedules(120_000), 1);
		const queued = inbox.nextPending();
		assert.ok(queued);
		assert.equal(queued.scheduleId, "routine");
		assert.equal(routines.enqueueDueSchedules(180_000), 0);
		assert.equal(routines.runScheduleNow("routine"), false);
		assert.equal(inbox.markProcessing(queued.id), true);
		assert.equal(routines.enqueueDueSchedules(240_000), 0);
		assert.equal(routines.runScheduleNow("routine"), false);
		assert.equal(inbox.complete(queued.id, "same result"), true);
		assert.equal(routines.runScheduleNow("routine"), true);
		assert.equal(routines.runScheduleNow("routine"), false);
		assert.equal(inbox.nextPending()?.scheduleId, "routine");
	} finally {
		stateDb.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("changes_only suppresses unchanged and explicitly quiet results while preserving the latest result", () => {
	withRoutines((inbox, routines) => {
		routines.createSchedule({ id: "watch", label: "Watch", prompt: "check", dueAt: 1_000, source: "internal", notificationPolicy: "changes_only" });
		assert.equal(routines.runScheduleNow("watch"), true);
		const first = inbox.nextPending();
		assert.ok(first);
		assert.equal(inbox.markProcessing(first.id), true);
		assert.equal(inbox.complete(first.id, "unchanged baseline", false), true);
		assert.deepEqual(inbox.pendingDeliveries(), []);
		assert.equal(routines.getSchedule("watch")?.lastResult, "unchanged baseline");
		assert.equal(routines.runScheduleNow("watch"), true);
		const second = inbox.nextPending();
		assert.ok(second);
		assert.equal(inbox.markProcessing(second.id), true);
		assert.equal(inbox.complete(second.id, "unchanged baseline"), true);
		assert.deepEqual(inbox.pendingDeliveries(), []);
		assert.equal(routines.runScheduleNow("watch"), true);
		const third = inbox.nextPending();
		assert.ok(third);
		assert.equal(inbox.markProcessing(third.id), true);
		assert.equal(inbox.complete(third.id, "meaningful update"), true);
		assert.equal(inbox.pendingDeliveries()[0]?.response, "meaningful update");
		assert.equal(routines.getSchedule("watch")?.lastNotifiedResult, "meaningful update");
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
	const inbox = new Inbox(stateDb);
	const routines = new Routines(stateDb, inbox);
	try {
		assert.deepEqual(routines.getSchedule("old"), {
			id: "old", label: "Old routine", prompt: "keep me", dueAt: 12345, intervalMs: 60000,
			source: "terminal", enabled: true, createdAt: 7, cron: null, timezone: "UTC",
			notificationPolicy: "always", lastResult: null, lastNotifiedResult: null, paused: false,
		});
		assert.equal(routines.enqueueDueSchedules(12345), 1);
		assert.equal(inbox.nextPending()?.scheduleId, "old");
	} finally {
		stateDb.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
