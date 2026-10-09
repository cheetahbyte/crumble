import assert from "node:assert/strict";
import { test } from "node:test";
import { Inbox, InboxProcessor } from "../../src/inbox/inbox.ts";
import { openDatabase } from "../../src/db/database.ts";

test("concurrent wakes serialize turns and drain arrivals during a running turn", async () => {
	const stateDb = openDatabase(":memory:", "assistant");
	const inbox = new Inbox(stateDb);
	const seen: string[] = [];
	const activity: Array<[string, boolean]> = [];
	let release!: () => void;
	const barrier = new Promise<void>((resolve) => { release = resolve; });
	const processor = new InboxProcessor({
		inbox, changed() {}, activity: (request, active) => { activity.push([request.id, active]); }, handle: async (request) => {
			seen.push(request.id);
			if (request.id === "first") await barrier;
			return `result:${request.id}`;
		},
	});
	inbox.enqueue({ id: "first", text: "one", source: "terminal" });
	const first = processor.wake();
	inbox.enqueue({ id: "second", text: "two", source: "terminal" });
	assert.equal(processor.wake(), first);
	assert.deepEqual(seen, ["first"]);
	assert.deepEqual(activity, [["first", true]]);
	release();
	await first;
	assert.deepEqual(seen, ["first", "second"]);
	assert.deepEqual(activity, [["first", true], ["first", false], ["second", true], ["second", false]]);
	assert.equal(inbox.pendingDeliveries().length, 2);
	await processor.wake();
	assert.equal(seen.length, 2);
	await processor.close(); stateDb.close();
});

test("failed turns leave a durable reply and do not prevent later requests", async () => {
	const stateDb = openDatabase(":memory:", "assistant");
	const inbox = new Inbox(stateDb);
	inbox.enqueue({ id: "a", text: "fail", source: "discord" });
	inbox.enqueue({ id: "b", text: "succeed", source: "discord" });
	const activity: boolean[] = [];
	const processor = new InboxProcessor({ inbox, changed() {}, activity: (_request, active) => { activity.push(active); }, handle: async (request) => {
		if (request.text === "fail") throw new Error("model unavailable");
		return "done";
	} });
	await processor.wake();
	assert.deepEqual(activity, [true, false, true, false]);
	assert.equal(inbox.get("a")?.status, "failed");
	assert.equal(inbox.get("b")?.status, "completed");
	assert.equal(inbox.pendingDeliveries().length, 2);
	await processor.close(); stateDb.close();
});

test("presence failures do not fail durable assistant requests", async () => {
	const stateDb = openDatabase(":memory:", "assistant");
	const inbox = new Inbox(stateDb);
	inbox.enqueue({ id: "a", text: "hello", source: "discord" });
	const processor = new InboxProcessor({ inbox, changed() {}, activity() { throw new Error("presence unavailable"); }, handle: async () => "done" });
	await processor.wake();
	assert.equal(inbox.get("a")?.status, "completed");
	await processor.close(); stateDb.close();
});
