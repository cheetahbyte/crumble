import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { loadAppConfig } from "#config";

test("default provider resolves the OpenAI OAuth credential saved by Pi login", async () => {
	const dir = mkdtempSync(join(tmpdir(), "crumble-auth-"));
	try {
		const configPath = join(dir, "config.json");
		writeFileSync(configPath, JSON.stringify({ tenants: [{ id: "test" }] }));
		const config = loadAppConfig({ CRUMBLE_CONFIG: configPath });
		const authPath = join(dir, "auth.json");
		writeFileSync(authPath, JSON.stringify({ openai: {
			type: "oauth", access: "test-access", refresh: "test-refresh", expires: Date.now() + 3_600_000,
		} }));
		const runtime = await ModelRuntime.create({ authPath, modelsPath: join(dir, "models.json"), modelsStorePath: join(dir, "cache.json") });
		const model = runtime.getModel(config.provider, config.model);
		assert.ok(model, "default model must be registered");
		assert.ok(await runtime.getAuth(model), "default model must resolve Pi's saved OpenAI login");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
