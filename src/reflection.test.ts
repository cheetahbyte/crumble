import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AssistantState } from "./state.ts";
import { LearningStore } from "./learning.ts";
import { applyLearning, reviewLearning } from "./reflection.ts";

test("learning validates evidence before writes and retains skill provenance", async () => {
	const root = mkdtempSync(join(tmpdir(), "crumble-reflect-"));
	const state = new AssistantState(join(root, "state.db"));
	const learning = new LearningStore(join(root, "state.db"));
	state.enqueue({ id: "one", text: "I prefer short replies. Always check the output before delivery.", source: "discord" });
	const request = state.get("one")!;
	try {
		const proposal = { memories: [{ key: "response-length", value: "Short replies", evidence: "I prefer short replies." }], skills: [{ name: "delivery", description: "Verify delivery", instructions: "Before delivery, check the output.", reason: "User correction", evidence: "Always check the output before delivery." }] };
		assert.equal(applyLearning(JSON.stringify(proposal), request, "", state, learning), 2);
		assert.equal(state.getMemory("response-length"), "Short replies");
		assert.equal(learning.readSkill("delivery")?.sourceRequestId, "one");
		proposal.memories[0]!.value = "Long replies";
		proposal.skills[0]!.evidence = "Invented evidence";
		assert.throws(() => applyLearning(JSON.stringify(proposal), request, "", state, learning));
		assert.equal(state.getMemory("response-length"), "Short replies");
		learning.disableSkill("delivery");
		proposal.skills[0]!.evidence = "Always check the output before delivery.";
		applyLearning(JSON.stringify(proposal), request, "", state, learning);
		assert.equal(learning.readSkill("delivery")?.version, 1);
		learning.deleteSkill("delivery");
		applyLearning(JSON.stringify({ memories: [], skills: proposal.skills }), request, "", state, learning);
		assert.equal(learning.readSkill("delivery"), undefined, "automatic learning cannot recreate deleted skills");
		learning.setLearningEnabled(false);
		await reviewLearning({ request, reply: "done", evidence: "", state, learning, generate: async () => { throw new Error("must not call model"); } });
		learning.setLearningEnabled(true);
		assert.equal(applyLearning(JSON.stringify(proposal), { ...request, source: "internal" }, "", state, learning), 0);
		assert.throws(() => applyLearning(JSON.stringify({ memories: [{ key: "secret", value: "api_key=private", evidence: "I prefer short replies." }], skills: [] }), request, "", state, learning));
	} finally { learning.close(); state.close(); rmSync(root, { recursive: true, force: true }); }
});

test("learning keeps UTF-16 size limits and validates all entries before writes", () => {
	const root = mkdtempSync(join(tmpdir(), "crumble-reflect-size-"));
	const state = new AssistantState(join(root, "state.db"));
	const learning = new LearningStore(join(root, "state.db"));
	state.enqueue({ id: "size", text: "Remember this evidence.", source: "discord" });
	const request = state.get("size")!;
	try {
		const proposal = {
			memories: [{ key: "😀".repeat(256), value: "value", evidence: "Remember this evidence." }],
			skills: [{ name: "valid", description: "Valid", instructions: "Keep it", reason: "Evidence", evidence: "Remember this evidence." }],
		};
		assert.throws(() => applyLearning(JSON.stringify(proposal), request, "", state, learning));
		assert.equal(state.listMemory().length, 0);
		assert.equal(learning.readSkill("valid"), undefined);
	} finally { learning.close(); state.close(); rmSync(root, { recursive: true, force: true }); }
});
