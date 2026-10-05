import assert from "node:assert/strict";
import { test } from "node:test";
import { InboxProcessor } from "./inbox.ts";
import { AssistantState } from "./state.ts";

test("concurrent wakes serialize turns and drain arrivals during a running turn", async () => {
	const state = new AssistantState(":memory:");
	const seen: string[] = [];
	const activity: Array<[string, boolean]> = [];
	let release!: () => void;
	const barrier = new Promise<void>((resolve) => { release = resolve; });
	const inbox = new InboxProcessor({
		state, changed() {}, activity: (request, active) => { activity.push([request.id, active]); }, handle: async (request) => {
			seen.push(request.id);
			if (request.id === "first") await barrier;
			return `result:${request.id}`;
		},
	});
	state.enqueue({ id: "first", text: "one", source: "terminal" });
	const first = inbox.wake();
	state.enqueue({ id: "second", text: "two", source: "terminal" });
	assert.equal(inbox.wake(), first);
	assert.deepEqual(seen, ["first"]);
	assert.deepEqual(activity, [["first", true]]);
	release();
	await first;
	assert.deepEqual(seen, ["first", "second"]);
	assert.deepEqual(activity, [["first", true], ["first", false], ["second", true], ["second", false]]);
	assert.equal(state.pendingDeliveries().length, 2);
	await inbox.wake();
	assert.equal(seen.length, 2);
	await inbox.close(); state.close();
});

test("failed turns leave a durable reply and do not prevent later requests", async () => {
	const state = new AssistantState(":memory:");
	state.enqueue({ id: "a", text: "fail", source: "discord" });
	state.enqueue({ id: "b", text: "succeed", source: "discord" });
	const activity: boolean[] = [];
	const inbox = new InboxProcessor({ state, changed() {}, activity: (_request, active) => { activity.push(active); }, handle: async (request) => {
		if (request.text === "fail") throw new Error("model unavailable");
		return "done";
	} });
	await inbox.wake();
	assert.deepEqual(activity, [true, false, true, false]);
	assert.equal(state.get("a")?.status, "failed");
	assert.equal(state.get("b")?.status, "completed");
	assert.equal(state.pendingDeliveries().length, 2);
	await inbox.close(); state.close();
});

test("presence failures do not fail durable assistant requests", async () => {
	const state = new AssistantState(":memory:");
	state.enqueue({ id: "a", text: "hello", source: "discord" });
	const inbox = new InboxProcessor({ state, changed() {}, activity() { throw new Error("presence unavailable"); }, handle: async () => "done" });
	await inbox.wake();
	assert.equal(state.get("a")?.status, "completed");
	await inbox.close(); state.close();
});

test("learning happens after durable delivery and cannot fail the reply", async () => {
	const state = new AssistantState(":memory:");
	state.enqueue({ id: "learn", text: "a preference", source: "discord" });
	let delivered = false;
	let presence = false;
	const inbox = new InboxProcessor({ state, handle: async () => "saved", changed() { delivered = true; },
		activity(_request, active) { presence = active; },
		afterComplete: async () => {
			assert.equal(delivered, true);
			assert.equal(presence, false);
			assert.equal(state.get("learn")?.status, "completed");
			throw new Error("learning failed");
		},
	});
	await inbox.wake();
	assert.equal(state.get("learn")?.response, "saved");
	await inbox.close(); state.close();
});
