import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AssistantState } from "./state.ts";

test("memory revisions persist and rollback restores successive prior saves", () => {
	const directory = mkdtempSync(join(tmpdir(), "crumble-memory-revisions-"));
	const path = join(directory, "assistant.db");
	let state = new AssistantState(path);
	try {
		state.setMemory("style", "brief", "User prefers concise answers");
		const first = state.memoryHistory("style");
		assert.equal(first.length, 1);
		assert.equal(first[0]?.reason, "User prefers concise answers");
		state.setMemory("style", "brief", "Repeated identical value");
		assert.equal(state.memoryHistory("style").length, 1, "identical saves do not create revisions");
		state.setMemory("style", "detailed", "User corrected the preference");
		assert.equal(state.memoryHistory("style").length, 2);
		state.close();

		state = new AssistantState(path);
		assert.equal(state.getMemory("style"), "detailed");
		assert.equal(state.rollbackMemory("style"), true);
		assert.equal(state.getMemory("style"), "brief");
		assert.equal(state.memoryHistory("style")[0]?.operation, "rollback");
		assert.equal(state.rollbackMemory("style"), false, "the oldest saved revision has no earlier value");
	} finally {
		state.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("forget removes the current memory and all of its revisions", () => {
	const directory = mkdtempSync(join(tmpdir(), "crumble-memory-forget-"));
	const state = new AssistantState(join(directory, "assistant.db"));
	try {
		state.setMemory("timezone", "UTC");
		state.setMemory("timezone", "Europe/Berlin", "User corrected timezone");
		assert.equal(state.deleteMemory("timezone"), true);
		assert.equal(state.getMemory("timezone"), undefined);
		assert.deepEqual(state.memoryHistory("timezone"), []);
		assert.equal(state.rollbackMemory("timezone"), false);
		assert.equal(state.deleteMemory("timezone"), false);
	} finally {
		state.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("legacy memories receive an imported first revision", () => {
	const directory = mkdtempSync(join(tmpdir(), "crumble-memory-migrate-"));
	const path = join(directory, "assistant.db");
	const legacy = new DatabaseSync(path);
	legacy.exec("CREATE TABLE assistant_memory (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL)");
	legacy.prepare("INSERT INTO assistant_memory VALUES (?, ?, ?)").run("tone", JSON.stringify("warm"), 1234);
	legacy.close();
	const state = new AssistantState(path);
	try {
		assert.equal(state.getMemory("tone"), "warm");
		assert.deepEqual(state.memoryHistory("tone").map(({ value, reason, operation }) => ({ value, reason, operation })), [
			{ value: "warm", reason: "Imported existing memory", operation: "import" },
		]);
	} finally {
		state.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("memory revision history remains isolated by tenant database", () => {
	const directory = mkdtempSync(join(tmpdir(), "crumble-memory-isolation-"));
	const alice = new AssistantState(join(directory, "alice.db"));
	const bob = new AssistantState(join(directory, "bob.db"));
	try {
		alice.setMemory("preference", "private");
		alice.setMemory("preference", "corrected");
		assert.deepEqual(bob.memoryHistory("preference"), []);
		assert.equal(bob.rollbackMemory("preference"), false);
	} finally {
		alice.close();
		bob.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
