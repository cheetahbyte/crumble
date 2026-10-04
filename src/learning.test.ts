import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LearningStore } from "./learning.ts";
import { AssistantState, type InboundSource } from "./state.ts";

function withTenant(run: (state: AssistantState, store: LearningStore, directory: string) => void): void {
	const directory = mkdtempSync(join(tmpdir(), "crumble-learning-"));
	const path = join(directory, "assistant.db");
	const state = new AssistantState(path);
	const store = new LearningStore(path);
	try {
		run(state, store, directory);
	} finally {
		store.close();
		state.close();
		rmSync(directory, { recursive: true, force: true });
	}
}

function complete(state: AssistantState, id: string, request: string, response: string, source: InboundSource = "terminal"): void {
	assert.equal(state.enqueue({ id, text: request, source }), true);
	assert.equal(state.markProcessing(id), true);
	assert.equal(state.complete(id, response), true);
}

test("finished inbox history is backfilled, searchable, and returned by ID", () => {
	const directory = mkdtempSync(join(tmpdir(), "crumble-learning-backfill-"));
	const path = join(directory, "assistant.db");
	const state = new AssistantState(path);
	try {
		complete(state, "terminal:old", "Find the lunar calendar conversion", "Converted the lunar calendar date to a solar date.");
		const store = new LearningStore(path);
		try {
			const results = store.searchHistory("lunar OR * calendar", 5);
			assert.equal(results.length, 1);
			assert.equal(results[0]?.id, "terminal:old");
			assert.equal(results[0]?.source, "terminal");
			assert.match(results[0]?.snippet ?? "", /lunar/i);
			assert.equal("response" in (results[0] ?? {}), false, "search should return a snippet, not the full transcript");
			assert.deepEqual(store.readHistory("terminal:old"), {
				id: "terminal:old",
				request: "Find the lunar calendar conversion",
				response: "Converted the lunar calendar date to a solar date.",
				source: "terminal",
				status: "completed",
				createdAt: results[0]?.createdAt,
				updatedAt: results[0]?.updatedAt,
			});
			assert.equal(store.readHistory("missing"), undefined);
		} finally {
			store.close();
		}
	} finally {
		state.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("inbox completion and edits keep the FTS index current across reopen", () => {
	const directory = mkdtempSync(join(tmpdir(), "crumble-learning-live-"));
	const path = join(directory, "assistant.db");
	const state = new AssistantState(path);
	let store = new LearningStore(path);
	try {
		complete(state, "discord:new", "Plan a garden", "Use basil and thyme.", "discord");
		assert.equal(store.searchHistory("basil")[0]?.id, "discord:new");
		state.enqueue({ id: "internal:pending", text: "confidential pending item", source: "internal" });
		assert.deepEqual(store.searchHistory("confidential"), []);

		store.close();
		store = new LearningStore(path);
		assert.equal(store.readHistory("discord:new")?.response, "Use basil and thyme.");
		assert.equal(store.searchHistory("thyme")[0]?.source, "discord");
		assert.deepEqual(store.searchHistory("garden", 1, 1), []);
		assert.throws(() => store.searchHistory("x", 26), /limit/);

		const deletion = new DatabaseSync(path);
		try {
			deletion.prepare("DELETE FROM assistant_inbox WHERE id = ?").run("discord:new");
		} finally {
			deletion.close();
		}
		assert.deepEqual(store.searchHistory("thyme"), []);
	} finally {
		store.close();
		state.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("search snippets have a character cap even when matching long tokens", () => {
	withTenant((state, store) => {
		const tokenA = "a".repeat(400);
		const tokenB = "b".repeat(400);
		const tokenC = "c".repeat(400);
		complete(state, "terminal:long-word", `${tokenA} ${tokenB} ${tokenC}`, "Three long tokens.");
		const snippet = store.searchHistory(tokenA)[0]?.snippet;
		assert.ok(snippet);
		assert.ok(snippet.length <= 1_000, `snippet was ${snippet.length} characters`);
	});
});

test("history and learned procedures are isolated by tenant database", () => {
	const directory = mkdtempSync(join(tmpdir(), "crumble-learning-tenants-"));
	const aPath = join(directory, "a.db");
	const bPath = join(directory, "b.db");
	const aState = new AssistantState(aPath);
	const bState = new AssistantState(bPath);
	const a = new LearningStore(aPath);
	const b = new LearningStore(bPath);
	try {
		complete(aState, "terminal:a", "Tenant-only phrase quartz", "Private answer");
		assert.equal(a.searchHistory("quartz").length, 1);
		assert.deepEqual(b.searchHistory("quartz"), []);
		a.saveSkill("gardening", "Plan small gardens", "Prefer herbs that share water needs.");
		assert.equal(a.readSkill("gardening")?.instructions, "Prefer herbs that share water needs.");
		assert.equal(b.readSkill("gardening"), undefined);
	} finally {
		a.close();
		b.close();
		aState.close();
		bState.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("skill revisions can roll back without re-enabling a disabled skill", () => {
	withTenant((_state, store) => {
		assert.deepEqual(store.listSkills(), []);
		assert.equal(store.saveSkill("release", "Prepare a release", "Check the change log first.").version, 1);
		assert.equal(store.saveSkill("release", "Prepare a release", "Check the change log and tags.").version, 2);
		assert.equal(store.disableSkill("release"), true);
		const rolledBack = store.rollbackSkill("release");
		assert.equal(rolledBack?.version, 1);
		assert.equal(rolledBack?.instructions, "Check the change log first.");
		assert.equal(rolledBack?.enabled, false);
		assert.equal(store.enableSkill("release"), true);
		assert.equal(store.readSkill("release")?.enabled, true);
		assert.equal(store.saveSkill("release", "Prepare a release", "Check the change log, tags, and artifacts.").version, 3);
		assert.equal(store.rollbackSkill("release", 9), undefined);
		assert.throws(() => store.saveSkill("oversize", "desc", "x".repeat(12_001)), /instructions/);
	});
});
