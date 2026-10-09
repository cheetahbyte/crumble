import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Inbox, InboxProcessor } from "#inbox";
import { Routines } from "#routines";
import { LearningStore } from "#learning";
import { jobsExtension } from "#jobs/extension";
import { openDatabase } from "#db/database";

test("quiet routine results remain searchable while ordinary replies cannot be suppressed", async () => {
	const root = mkdtempSync(join(tmpdir(), "crumble-routine-integration-"));
	const path = join(root, "assistant.db");
	const stateDb = openDatabase(path, "assistant");
	const inbox = new Inbox(stateDb);
	const routines = new Routines(stateDb, inbox);
	const learningDb = openDatabase(path, "assistant");
	const learning = new LearningStore(learningDb);
	const processor = new InboxProcessor({ inbox, changed() {}, handle: async () => ({ text: "Checked inventory: unchanged", notify: false }) });
	try {
		routines.createSchedule({ id: "monitor", label: "Inventory", prompt: "Check inventory", source: "discord", dueAt: 1, notificationPolicy: "changes_only" });
		routines.enqueueDueSchedules(2);
		await processor.wake();
		assert.equal(inbox.pendingDeliveries().length, 0);
		assert.equal(learning.searchHistory("inventory").length, 1);
		assert.equal(routines.getSchedule("monitor")?.lastResult, "Checked inventory: unchanged");
		inbox.enqueue({ id: "direct", text: "Check now", source: "discord" });
		await processor.wake();
		assert.deepEqual(inbox.pendingDeliveries().map((d) => d.id), ["direct"]);
	} finally {
		await processor.close(); learningDb.close(); stateDb.close(); rmSync(root, { recursive: true, force: true });
	}
});

test("quiet routines cannot spawn independently reporting background jobs", async () => {
	const registered = new Map<string, { execute: (id: string, params: unknown) => Promise<unknown> }>();
	jobsExtension({ supervisor: {} as never, store: {} as never, dirs: { rootDir: "/unused", workspacesDir: "/unused" }, canDelegate: () => false })({
		registerTool(tool: { name: string; execute: (id: string, params: unknown) => Promise<unknown> }) { registered.set(tool.name, tool); },
	} as never);
	await assert.rejects(registered.get("delegate")!.execute("call", { brief: "check" }), /Quiet monitors/);
	await assert.rejects(registered.get("message_job")!.execute("call", { job_id: "job", message: "check" }), /Quiet monitors/);
});
