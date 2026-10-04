import assert from "node:assert/strict";
import { test } from "node:test";
import { authLoginPaths, selectAuthType } from "./auth-login.ts";
import { createTenantConfig } from "./tenants.ts";

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

test("authentication defaults to OAuth when available and retains API-key login support", () => {
	assert.equal(selectAuthType({ auth: { oauth: {}, apiKey: { login() {} } } }), "oauth");
	assert.equal(selectAuthType({ auth: { apiKey: { login() {} } } }), "api_key");
	assert.equal(selectAuthType({ auth: { oauth: {}, apiKey: { login() {} } } }, "api_key"), "api_key");
	assert.throws(() => selectAuthType({ auth: { apiKey: { login() {} } } }, "oauth"), /does not support OAuth/);
	assert.throws(() => selectAuthType({ auth: { oauth: {} } }, "api_key"), /does not support API key/);
});
