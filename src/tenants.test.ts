import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadAppConfig } from "./config.ts";
import { createTenantConfig, prepareTenant, tenantEnvironment, validateTenants } from "./tenants.ts";

function withTempDir(fn: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "crumble-tenants-"));
	try {
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("configured tenants get isolated state and per-tenant provider/model overrides", () => {
	withTempDir((dir) => {
		const path = join(dir, "crumble.json");
		writeFileSync(path, JSON.stringify({
			dataDir: "state",
			provider: "default-provider",
			model: "default-model",
			tenants: [
				{ id: "lea", discordUserId: "12345678901234567" },
				{ id: "alex", provider: "other-provider", model: "other-model", discordUserId: "23456789012345678", timezone: "America/New_York" },
			],
		}));
		const config = loadAppConfig({ CRUMBLE_CONFIG: path });
		assert.equal(config.selectedTenantId, "lea");
		assert.equal(config.tenants[0]?.provider, "default-provider");
		assert.equal(config.tenants[0]?.timezone, "Europe/Berlin");
		assert.equal(config.tenants[1]?.provider, "other-provider");
		assert.equal(config.tenants[1]?.timezone, "America/New_York");
		assert.notEqual(config.tenants[0]?.homeDir, config.tenants[1]?.homeDir);
		assert.notEqual(config.tenants[0]?.agentDir, config.tenants[1]?.agentDir);
		assert.notEqual(config.tenants[0]?.jobsDatabasePath, config.tenants[1]?.jobsDatabasePath);
		assert.equal(config.tenants[0]?.workspacesDir, join(dir, "state", "tenants", "lea", "workspaces"));
		assert.equal(config.tenants[0]?.stateDatabasePath, join(dir, "state", "tenants", "lea", "assistant.db"));
	});
});

test("a configured file must list tenants and a selected tenant must exist", () => {
	withTempDir((dir) => {
		const path = join(dir, "crumble.json");
		writeFileSync(path, "{}");
		assert.throws(() => loadAppConfig({ CRUMBLE_CONFIG: path }), /explicit tenants array/);
		writeFileSync(path, JSON.stringify({ tenants: [{ id: "one" }] }));
		assert.throws(() => loadAppConfig({ CRUMBLE_CONFIG: path, CRUMBLE_TENANT: "missing" }), /must name a configured tenant/);
	});
});

test("tenant IDs and Discord account mappings are validated", () => {
	assert.throws(() => createTenantConfig("/data", { id: "../other" }, { provider: "p", model: "m" }), /Invalid tenant id/);
	assert.throws(() => createTenantConfig("/data", { id: "ok", discordUserId: "not-a-snowflake" }, { provider: "p", model: "m" }), /Invalid Discord user id/);
	const one = createTenantConfig("/data", { id: "one", discordUserId: "12345678901234567" }, { provider: "p", model: "m" });
	const two = createTenantConfig("/data", { id: "two", discordUserId: "12345678901234567" }, { provider: "p", model: "m" });
	assert.throws(() => validateTenants([one, two]), /assigned to more than one tenant/);
	assert.throws(() => validateTenants([one, one]), /Duplicate tenant id/);
	assert.throws(() => createTenantConfig("/data", { id: "ok", timezone: "Mars/Olympus" }, { provider: "p", model: "m" }), /Invalid timezone/);
});

test("tenant process environment does not inherit host credentials or service secrets", () => {
	const tenant = createTenantConfig("/data", { id: "one" }, { provider: "p", model: "m" });
	const env = tenantEnvironment(tenant, {
		PATH: "/bin",
		OPENAI_API_KEY: "host-secret",
		DISCORD_TOKEN: "bot-secret",
		AWS_PROFILE: "operator-profile",
	});
	assert.equal(env.PATH, "/bin");
	assert.equal(env.HOME, tenant.homeDir);
	assert.equal(env.XDG_CONFIG_HOME, join(tenant.homeDir, ".config"));
	assert.equal(env.PI_CODING_AGENT_DIR, tenant.agentDir);
	assert.equal(env.OPENAI_API_KEY, undefined);
	assert.equal(env.DISCORD_TOKEN, undefined);
	assert.equal(env.AWS_PROFILE, undefined);
});

test("preparing a tenant creates its personal workspace and rejects a symlinked tenant root", () => {
	withTempDir((dir) => {
		const tenant = createTenantConfig(dir, { id: "one" }, { provider: "p", model: "m" });
		prepareTenant(tenant);
		assert.equal(tenant.workspacesDir, join(tenant.rootDir, "workspaces"));
		assert.doesNotThrow(() => requireDirectory(join(tenant.workspacesDir, "personal")));
	});
	withTempDir((dir) => {
		const outside = join(dir, "outside");
		mkdirSync(outside);
		const tenants = join(dir, "state", "tenants");
		mkdirSync(tenants, { recursive: true });
		const rootDir = join(tenants, "one");
		symlinkSync(outside, rootDir, "dir");
		const tenant = createTenantConfig(join(dir, "state"), { id: "one" }, { provider: "p", model: "m" });
		assert.throws(() => prepareTenant(tenant), /Tenant root must be a real directory/);
	});
});

test("preparing a tenant rejects symlinked databases, SQLite sidecars, and Pi config files", () => {
	withTempDir((dir) => {
		const tenant = createTenantConfig(dir, { id: "one" }, { provider: "p", model: "m" });
		prepareTenant(tenant);
		const target = join(dir, "other-tenant-file");
		writeFileSync(target, "private");
		const protectedPaths = [
			tenant.stateDatabasePath,
			`${tenant.stateDatabasePath}-wal`,
			`${tenant.stateDatabasePath}-shm`,
			tenant.jobsDatabasePath,
			`${tenant.jobsDatabasePath}-wal`,
			`${tenant.jobsDatabasePath}-shm`,
			join(tenant.agentDir, "auth.json"),
			join(tenant.agentDir, "models.json"),
			join(tenant.agentDir, "models-cache.json"),
		];
		for (const path of protectedPaths) {
			symlinkSync(target, path);
			assert.throws(() => prepareTenant(tenant), /must not be a symbolic link/);
			rmSync(path);
		}
	});
});

function requireDirectory(path: string): void {
	assert.ok(statSync(path).isDirectory() && lstatSync(path).isDirectory());
}
