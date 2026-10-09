import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LearningStore } from "./learning.ts";
import { learningExtension } from "./extensions/learning.ts";
import { AssistantState, type InboundSource } from "./state.ts";
import { openDatabase } from "./db/database.ts";

function withTenant(run: (state: AssistantState, store: LearningStore, directory: string) => void): void {
	const directory = mkdtempSync(join(tmpdir(), "crumble-learning-"));
	const path = join(directory, "assistant.db");
	const stateDb = openDatabase(path, "assistant");
	const state = new AssistantState(stateDb);
	const storeDb = openDatabase(path, "assistant");
	const store = new LearningStore(storeDb);
	try {
		run(state, store, directory);
	} finally {
		storeDb.close();
		stateDb.close();
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
	const stateDb = openDatabase(path, "assistant");
	const state = new AssistantState(stateDb);
	try {
		complete(state, "terminal:old", "Find the lunar calendar conversion", "Converted the lunar calendar date to a solar date.");
		const storeDb = openDatabase(path, "assistant");
		const store = new LearningStore(storeDb);
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
			storeDb.close();
		}
	} finally {
		stateDb.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("inbox completion and edits keep the FTS index current across reopen", () => {
	const directory = mkdtempSync(join(tmpdir(), "crumble-learning-live-"));
	const path = join(directory, "assistant.db");
	const stateDb = openDatabase(path, "assistant");
	const state = new AssistantState(stateDb);
	let storeDb = openDatabase(path, "assistant");
	let store = new LearningStore(storeDb);
	try {
		complete(state, "discord:new", "Plan a garden", "Use basil and thyme.", "discord");
		assert.equal(store.searchHistory("basil")[0]?.id, "discord:new");
		state.enqueue({ id: "internal:pending", text: "confidential pending item", source: "internal" });
		assert.deepEqual(store.searchHistory("confidential"), []);

		storeDb.close();
		storeDb = openDatabase(path, "assistant");
		store = new LearningStore(storeDb);
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
		storeDb.close();
		stateDb.close();
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
	const aStateDb = openDatabase(aPath, "assistant");
	const aState = new AssistantState(aStateDb);
	const bStateDb = openDatabase(bPath, "assistant");
	const bState = new AssistantState(bStateDb);
	const aDb = openDatabase(aPath, "assistant");
	const a = new LearningStore(aDb);
	const bDb = openDatabase(bPath, "assistant");
	const b = new LearningStore(bDb);
	try {
		complete(aState, "terminal:a", "Tenant-only phrase quartz", "Private answer");
		assert.equal(a.searchHistory("quartz").length, 1);
		assert.deepEqual(b.searchHistory("quartz"), []);
		a.saveSkill("gardening", "Plan small gardens", "Prefer herbs that share water needs.");
		assert.equal(a.readSkill("gardening")?.instructions, "Prefer herbs that share water needs.");
		assert.equal(b.readSkill("gardening"), undefined);
	} finally {
		aDb.close();
		bDb.close();
		aStateDb.close();
		bStateDb.close();
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

test("skill versions retain provenance and identical content does not create a revision", () => {
	withTenant((_state, store) => {
		const first = store.saveSkill("release", "Prepare a release", "Check tags and artifacts.", {
			sourceRequestId: "terminal:request-42",
			reason: "The verified release needed an artifact check.",
		});
		assert.equal(first.version, 1);
		assert.equal(first.sourceRequestId, "terminal:request-42");
		assert.equal(first.reason, "The verified release needed an artifact check.");
		const unchanged = store.saveSkill("release", "Prepare a release", "Check tags and artifacts.", {
			sourceRequestId: "terminal:later-request",
			reason: "A later save with the same procedure.",
		});
		assert.equal(unchanged.version, 1);
		assert.equal(unchanged.sourceRequestId, "terminal:request-42");
		const revised = store.saveSkill("release", "Prepare a release", "Check tags, artifacts, and deployment status.", {
			sourceRequestId: "terminal:request-43",
			reason: "Added a verified deployment status check.",
		});
		assert.equal(revised.version, 2);
		assert.deepEqual(store.skillHistory("release"), [
			{
				version: 2,
				createdAt: revised.updatedAt,
				sourceRequestId: "terminal:request-43",
				reason: "Added a verified deployment status check.",
			},
			{
				version: 1,
				createdAt: first.updatedAt,
				sourceRequestId: "terminal:request-42",
				reason: "The verified release needed an artifact check.",
			},
		]);
	});
});

test("skill search ranks relevant enabled skills and never returns disabled skills", () => {
	withTenant((_state, store) => {
		store.saveSkill("gardening", "Plan a small herb garden", "Group basil and thyme by sunlight and water needs.");
		store.saveSkill("release", "Prepare a software release", "Check release tags and deployment artifacts.");
		store.saveSkill("private release notes", "Write internal release notes", "Summarize release changes.");
		store.disableSkill("private release notes");
		const results = store.searchSkills("release deployment tags", 2);
		assert.deepEqual(results.map(({ name }) => name), ["release"]);
		assert.ok(results.every(({ enabled }) => enabled));
		assert.equal("instructions" in (results[0] ?? {}), false);
		assert.deepEqual(store.searchSkills("no matching terms"), []);
		assert.throws(() => store.searchSkills("release", 26), /limit/);
	});
});

test("deleting a skill removes every version and learning preference persists", () => {
	withTenant((_state, store) => {
		assert.equal(store.learningEnabled(), true);
		store.setLearningEnabled(false);
		assert.equal(store.learningEnabled(), false);
		store.saveSkill("cleanup", "Clean temporary files", "Remove generated artifacts.");
		store.saveSkill("cleanup", "Clean temporary files", "Remove generated artifacts and caches.");
		assert.equal(store.deleteSkill("cleanup"), true);
		assert.equal(store.readSkill("cleanup"), undefined);
		assert.deepEqual(store.skillHistory("cleanup"), []);
		assert.equal(store.rollbackSkill("cleanup"), undefined);
		assert.equal(store.deleteSkill("cleanup"), false);
		assert.equal(store.isSkillDeleted("cleanup"), true);
		store.saveSkill("cleanup", "Clean temporary files", "Remove generated artifacts.");
		assert.equal(store.isSkillDeleted("cleanup"), false, "an explicit save clears the deletion marker");
		store.setLearningEnabled(true);
		assert.equal(store.learningEnabled(), true);
	});
});

test("learning extension bounds long request text before skill retrieval", async () => {
	type Event = { systemPromptOptions: { sections: Record<string, string> } };
	const event: Event = { systemPromptOptions: { sections: {} } };
	let prompt: Promise<void> | undefined;
	withTenant((_state, store) => {
		store.saveSkill("release", "Prepare a software release", "Check release tags and deployment artifacts.");
		let beforeAgentStart: ((event: Event) => Promise<void>) | undefined;
		const extension = learningExtension(store, {
			currentRequest: () => ({
				id: "terminal:long-request",
				source: "terminal",
				text: `Help with a software release. ${"context ".repeat(200)}`,
			}),
		});
		extension({
			on: (_event: string, handler: unknown) => { beforeAgentStart = handler as typeof beforeAgentStart; },
			registerTool: () => undefined,
		} as never);
		assert.ok(beforeAgentStart);
		prompt = beforeAgentStart(event);
	});
	assert.ok(prompt);
	await prompt;
	assert.match(event.systemPromptOptions.sections.learning ?? "", /"name":"release"/);
});
