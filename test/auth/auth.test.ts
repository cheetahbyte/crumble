import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authLoginPaths, runAuthLogin, selectAuthType } from "#auth";
import { createTenantConfig } from "#tenants";

test("Pi authentication stores and model catalogs are scoped to the tenant agent directory", () => {
	const tenant = createTenantConfig("/tmp/crumble-auth-test", { id: "alice", provider: "openai" }, {
		provider: "anthropic",
		model: "openai/gpt-5",
	});
	assert.deepEqual(authLoginPaths(tenant), {
		authPath: `${tenant.agentDir}/auth.json`,
		modelsPath: `${tenant.agentDir}/models.json`,
		modelsStorePath: `${tenant.agentDir}/models-cache.json`,
	});
});

test("ChatGPT login reaches its prompt with a persistent tenant-local installation ID", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "crumble-login-"));
	const originalEnv = { ...process.env };
	const tenant = createTenantConfig(dir, { id: "alice" }, { provider: "openai", model: "gpt-6-luna" });
	const networkBoundary = new Error("test reached OAuth network boundary");
	let requests = 0;
	t.mock.method(globalThis, "fetch", async () => {
		requests++;
		throw networkBoundary;
	});
	t.mock.method(console, "log", () => {});
	try {
		await assert.rejects(runAuthLogin(tenant), /Pi authentication prompts require an interactive terminal/);
		const settingsPath = join(tenant.agentDir, "settings.json");
		const firstId = JSON.parse(readFileSync(settingsPath, "utf8")).deviceId;
		assert.match(firstId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
		await assert.rejects(runAuthLogin(tenant), /Pi authentication prompts require an interactive terminal/);
		assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).deviceId, firstId);
		const other = createTenantConfig(dir, { id: "bob" }, { provider: "openai", model: "gpt-6-luna" });
		await assert.rejects(runAuthLogin(other), /Pi authentication prompts require an interactive terminal/);
		assert.notEqual(JSON.parse(readFileSync(join(other.agentDir, "settings.json"), "utf8")).deviceId, firstId);
		assert.equal(requests, 0);
	} finally {
		for (const key of Object.keys(process.env)) delete process.env[key];
		Object.assign(process.env, originalEnv);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("authentication defaults to OAuth when available and retains API-key login support", () => {
	assert.equal(selectAuthType({ auth: { oauth: {}, apiKey: { login() {} } } }), "oauth");
	assert.equal(selectAuthType({ auth: { apiKey: { login() {} } } }), "api_key");
	assert.equal(selectAuthType({ auth: { oauth: {}, apiKey: { login() {} } } }, "api_key"), "api_key");
	assert.throws(() => selectAuthType({ auth: { apiKey: { login() {} } } }, "oauth"), /does not support OAuth/);
	assert.throws(() => selectAuthType({ auth: { oauth: {} } }, "api_key"), /does not support API key/);
});
