import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TenantAssistant } from "./assistant.ts";
import { AssistantState } from "./state.ts";
import { LearningStore } from "./learning.ts";
import { createTenantConfig } from "./tenants.ts";
import { openDatabase } from "./db/database.ts";

test("learned skill controls stay usable without a model, including missing revisions", async () => {
	const root = mkdtempSync(join(tmpdir(), "crumble-controls-"));
	const stateDb = openDatabase(join(root, "assistant.db"), "assistant");
	const state = new AssistantState(stateDb);
	const learningDb = openDatabase(join(root, "assistant.db"), "assistant");
	const learning = new LearningStore(learningDb);
	const assistant = new TenantAssistant({
		tenant: createTenantConfig(root, { id: "test" }, { provider: "missing", model: "missing" }),
		state, learning, jobs: {} as never, plugins: {} as never, supervisor: {} as never,
		browser: { close: async () => {} } as never,
	});
	let sequence = 0;
	const command = (text: string) => {
		const id = String(++sequence);
		state.enqueue({ id, text, source: "discord" });
		return assistant.handle(state.get(id)!);
	};
	try {
		assert.equal(await command("/skill rollback absent"), '"No earlier version available."');
		learning.setMemory("style", "brief");
		learning.setMemory("style", "detailed");
		assert.equal(await command("/memory rollback style"), "Memory rolled back.");
		assert.equal(await command("/memory show style"), '"brief"');
		assert.equal(await command("/memory forget style"), "Forgotten.");
		assert.match(String(await command("/learning off")), /is off/);
		assert.equal(learning.learningEnabled(), false);
		assert.match(String(await command("/learning on")), /is on/);
		learning.saveSkill("release checklist", "Release", "Check the release.");
		assert.equal(await command("/skill disable release checklist"), "Disabled release checklist.");
		assert.match(String(await command("/skill show release checklist")), /Check the release/);
		assert.equal(await command("/skill enable release checklist"), "Enabled release checklist.");
	} finally {
		await assistant.close(); learningDb.close(); stateDb.close(); rmSync(root, { recursive: true, force: true });
	}
});
