import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TenantAssistant } from "./assistant.ts";
import { AssistantState } from "./state.ts";
import { LearningStore } from "./learning.ts";
import { createTenantConfig } from "./tenants.ts";

test("learned skill controls stay usable without a model, including missing revisions", async () => {
	const root = mkdtempSync(join(tmpdir(), "crumble-controls-"));
	const state = new AssistantState(join(root, "assistant.db"));
	const learning = new LearningStore(join(root, "assistant.db"));
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
		learning.saveSkill("release checklist", "Release", "Check the release.");
		assert.equal(await command("/skill disable release checklist"), "Disabled release checklist.");
		assert.match(String(await command("/skill show release checklist")), /Check the release/);
		assert.equal(await command("/skill enable release checklist"), "Enabled release checklist.");
	} finally {
		await assistant.close(); learning.close(); state.close(); rmSync(root, { recursive: true, force: true });
	}
});
