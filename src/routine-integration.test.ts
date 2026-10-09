import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AssistantState } from "./state.ts";
import { InboxProcessor } from "./inbox.ts";
import { LearningStore } from "./learning.ts";
import { delegateExtension } from "./extensions/delegate.ts";
import { openDatabase } from "./db/database.ts";

test("quiet routine results remain searchable while ordinary replies cannot be suppressed", async () => {
	const root = mkdtempSync(join(tmpdir(), "crumble-routine-integration-"));
	const path = join(root, "assistant.db");
	const stateDb = openDatabase(path, "assistant");
	const state = new AssistantState(stateDb);
	const learningDb = openDatabase(path, "assistant");
	const learning = new LearningStore(learningDb);
	const inbox = new InboxProcessor({ state, changed() {}, handle: async () => ({ text: "Checked inventory: unchanged", notify: false }) });
	try {
		state.createSchedule({ id: "monitor", label: "Inventory", prompt: "Check inventory", source: "discord", dueAt: 1, notificationPolicy: "changes_only" });
		state.enqueueDueSchedules(2);
		await inbox.wake();
		assert.equal(state.pendingDeliveries().length, 0);
		assert.equal(learning.searchHistory("inventory").length, 1);
		assert.equal(state.getSchedule("monitor")?.lastResult, "Checked inventory: unchanged");
		state.enqueue({ id: "direct", text: "Check now", source: "discord" });
		await inbox.wake();
		assert.deepEqual(state.pendingDeliveries().map((d) => d.id), ["direct"]);
	} finally {
		await inbox.close(); learningDb.close(); stateDb.close(); rmSync(root, { recursive: true, force: true });
	}
});

test("quiet routines cannot spawn independently reporting background jobs", async () => {
	const registered = new Map<string, { execute: (id: string, params: unknown) => Promise<unknown> }>();
	delegateExtension({} as never, {} as never, "/unused", () => "", () => false)({
		registerTool(tool: { name: string; execute: (id: string, params: unknown) => Promise<unknown> }) { registered.set(tool.name, tool); },
	} as never);
	await assert.rejects(registered.get("delegate")!.execute("call", { brief: "check" }), /Quiet monitors/);
	await assert.rejects(registered.get("message_job")!.execute("call", { job_id: "job", message: "check" }), /Quiet monitors/);
});
