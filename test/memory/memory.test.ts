import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MemoryStore } from "#memory";
import { openDatabase } from "#db/database";

test("memory revisions persist and rollback restores successive prior saves", () => {
	const directory = mkdtempSync(join(tmpdir(), "crumble-memory-revisions-"));
	const path = join(directory, "assistant.db");
	let stateDb = openDatabase(path, "assistant");
	let state = new MemoryStore(stateDb);
	try {
		state.set("style", "brief", "User prefers concise answers");
		const first = state.history("style");
		assert.equal(first.length, 1);
		assert.equal(first[0]?.reason, "User prefers concise answers");
		state.set("style", "brief", "Repeated identical value");
		assert.equal(state.history("style").length, 1, "identical saves do not create revisions");
		state.set("style", "detailed", "User corrected the preference");
		assert.equal(state.history("style").length, 2);
		stateDb.close();

		stateDb = openDatabase(path, "assistant");
		state = new MemoryStore(stateDb);
		assert.equal(state.get("style"), "detailed");
		assert.equal(state.rollback("style"), true);
		assert.equal(state.get("style"), "brief");
		assert.equal(state.history("style")[0]?.operation, "rollback");
		assert.equal(state.rollback("style"), false, "the oldest saved revision has no earlier value");
	} finally {
		stateDb.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("forget removes the current memory and all of its revisions", () => {
	const directory = mkdtempSync(join(tmpdir(), "crumble-memory-forget-"));
	const stateDb = openDatabase(join(directory, "assistant.db"), "assistant");
	const state = new MemoryStore(stateDb);
	try {
		state.set("timezone", "UTC");
		state.set("timezone", "Europe/Berlin", "User corrected timezone");
		assert.equal(state.delete("timezone"), true);
		assert.equal(state.get("timezone"), undefined);
		assert.deepEqual(state.history("timezone"), []);
		assert.equal(state.rollback("timezone"), false);
		assert.equal(state.delete("timezone"), false);
	} finally {
		stateDb.close();
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
	const stateDb = openDatabase(path, "assistant");
	const state = new MemoryStore(stateDb);
	try {
		assert.equal(state.get("tone"), "warm");
		assert.deepEqual(state.history("tone").map(({ value, reason, operation }) => ({ value, reason, operation })), [
			{ value: "warm", reason: "Imported existing memory", operation: "import" },
		]);
	} finally {
		stateDb.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("memory revision history remains isolated by tenant database", () => {
	const directory = mkdtempSync(join(tmpdir(), "crumble-memory-isolation-"));
	const aliceDb = openDatabase(join(directory, "alice.db"), "assistant");
	const alice = new MemoryStore(aliceDb);
	const bobDb = openDatabase(join(directory, "bob.db"), "assistant");
	const bob = new MemoryStore(bobDb);
	try {
		alice.set("preference", "private");
		alice.set("preference", "corrected");
		assert.deepEqual(bob.history("preference"), []);
		assert.equal(bob.rollback("preference"), false);
	} finally {
		aliceDb.close();
		bobDb.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("memory persists in its tenant database and tenant databases are isolated", () => {
	const directory = mkdtempSync(join(tmpdir(), "crumble-tenants-"));
	const aliceDb = openDatabase(join(directory, "alice.db"), "assistant");
	const alice = new MemoryStore(aliceDb);
	const bobDb = openDatabase(join(directory, "bob.db"), "assistant");
	const bob = new MemoryStore(bobDb);
	try {
		alice.set("preference", { concise: true });
		assert.deepEqual(alice.get("preference"), { concise: true });
		assert.equal(bob.get("preference"), undefined);
		assert.deepEqual(alice.list()[0]?.key, "preference");
		assert.equal(alice.delete("preference"), true);
		assert.equal(alice.delete("preference"), false);
	} finally {
		aliceDb.close();
		bobDb.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
