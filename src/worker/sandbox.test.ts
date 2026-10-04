import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runSandboxBash, workspacePath } from "./sandbox.ts";

test("workspace path mapping enforces a path component boundary", () => {
	assert.equal(workspacePath("/work/crumble", "/work/crumble/src/main.ts"), "/workspace/src/main.ts");
	assert.equal(workspacePath("/work/crumble", "/workspace"), "/workspace");
	assert.equal(workspacePath("/work/crumble", "/workspace/src/../main.ts"), "/workspace/main.ts");
	assert.throws(() => workspacePath("/work/crumble", "/workspace/../etc/passwd"), /inside the project workspace/);
	assert.throws(() => workspacePath("/work/crumble", "/workspace-other/file"), /inside the project workspace/);
	assert.throws(() => workspacePath("/work/crumble", "/work/crumble-other/file"), /inside the project workspace/);
	assert.throws(() => workspacePath("/work/crumble", "/etc/passwd"), /inside the project workspace/);
});

test("an already-aborted signal does not start a sandbox process", async () => {
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(runSandboxBash("missing-container", "/workspace", "true", { onData: () => {}, signal: controller.signal }), /aborted/);
});

test("aborting a sandbox bash command kills delayed file mutations in its process group", { timeout: 15_000 }, async (t) => {
	const image = process.env.CRUMBLE_SANDBOX_TEST_IMAGE ?? "crumble-sandbox";
	const available = spawnSync("docker", ["image", "inspect", image], { stdio: "ignore" }).status === 0;
	if (!available) {
		t.skip(`Docker image ${image} is unavailable`);
		return;
	}
	const dir = mkdtempSync(join(tmpdir(), "crumble-cancel-smoke-"));
	const container = `crumble-cancel-test-${process.pid}-${Date.now()}`;
	try {
		const started = spawnSync("docker", ["run", "-d", "--rm", "--name", container, "-v", `${dir}:/workspace`, "-w", "/workspace", image, "sleep", "infinity"], { encoding: "utf8" });
		assert.equal(started.status, 0, started.stderr);
		const controller = new AbortController();
		const execution = runSandboxBash(container, "/workspace", "sleep 2; printf late > /workspace/late", {
			onData: () => {}, signal: controller.signal,
		});
		setTimeout(() => controller.abort(), 150);
		await assert.rejects(execution, /aborted/);
		await new Promise((resolve) => setTimeout(resolve, 2_200));
		assert.equal(existsSync(join(dir, "late")), false, "the command mutated the workspace after cancellation");
		await runSandboxBash(container, "/workspace", "(sleep 2; printf orphan > /workspace/orphan) &", { onData: () => {} });
		await new Promise((resolve) => setTimeout(resolve, 2_200));
		assert.equal(existsSync(join(dir, "orphan")), false, "a background descendant survived normal command completion");
		await assert.rejects(
			runSandboxBash(container, "/workspace", "sleep 2; printf timeout > /workspace/timeout", { onData: () => {}, timeout: 0.2 }),
			/timeout:0.2/,
		);
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(existsSync(join(dir, "timeout")), false, "the command mutated the workspace after timeout");
	} finally {
		spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
		rmSync(dir, { recursive: true, force: true });
	}
});
