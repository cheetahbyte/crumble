import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { PluginManager } from "./plugins.ts";
import { dockerPluginExecutor } from "./plugin-executor.ts";

async function fixture() {
	const base = await mkdtemp(join(tmpdir(), "crumble-plugins-"));
	const workspacesDir = join(base, "workspaces");
	const source = join(workspacesDir, "capabilities", "weather");
	await mkdir(source, { recursive: true });
	await writeFile(join(source, "plugin.json"), JSON.stringify({ name: "weather", description: "Weather lookup", entry: "main.mjs", instructions: "Use for weather." }));
	await writeFile(join(source, "main.mjs"), "export default 1;\n");
	const entries: string[] = [];
	const manager = new PluginManager({
		rootDir: join(base, "plugins"),
		workspacesDir,
		image: "sandbox-test",
		tenantId: "alice",
		executor: async ({ input, entry }) => { entries.push(entry); return JSON.stringify(input); },
	});
	return { base, source, workspacesDir, manager, entries };
}

test("install, disable, enable, invoke, and rollback plugin snapshots", async () => {
	const f = await fixture();
	try {
		const v1 = await f.manager.install("capabilities/weather");
		assert.equal(v1.status, "enabled");
		assert.equal(await f.manager.invoke("weather", { city: "Berlin" }), '{"city":"Berlin"}');
		await f.manager.disable("weather");
		await assert.rejects(f.manager.invoke("weather", null), /disabled/);
		await f.manager.enable("weather");
		await f.manager.install("capabilities/weather"); // Reinstalling the same snapshot must not add a rollback entry.
		await writeFile(join(f.source, "plugin.json"), JSON.stringify({
			name: "weather", description: "Updated weather", entry: "next.mjs", instructions: "Use the updated method.",
		}));
		await writeFile(join(f.source, "next.mjs"), "export default 2;\n");
		const v2 = await f.manager.install("capabilities/weather");
		assert.notEqual(v1.version, v2.version);
		const rolledBack = await f.manager.rollback("weather");
		assert.equal(rolledBack.version, v1.version);
		assert.equal(rolledBack.status, "enabled");
		assert.equal(rolledBack.description, "Weather lookup");
		assert.equal(rolledBack.instructions, "Use for weather.");
		assert.equal(rolledBack.entry, "main.mjs");
		await f.manager.invoke("weather", { city: "Berlin" });
		assert.equal(f.entries.at(-1), "main.mjs");
		const toggledForward = await f.manager.rollback("weather");
		assert.equal(toggledForward.version, v2.version);
		assert.equal(toggledForward.description, "Updated weather");
		assert.equal(toggledForward.entry, "next.mjs");
	} finally { await rm(f.base, { recursive: true, force: true }); }
});

test("invalid paths and symlinks are rejected", async () => {
	const f = await fixture();
	try {
		await assert.rejects(f.manager.install("../outside"), /escapes/);
		await symlink(join(f.base, "outside"), join(f.source, "linked"));
		await assert.rejects(f.manager.install("capabilities/weather"), /symbolic links/);
		await rm(join(f.source, "linked"));
		await symlink(join(f.workspacesDir, "capabilities"), join(f.workspacesDir, "linked-capabilities"));
		await assert.rejects(f.manager.install("linked-capabilities/weather"), /symbolic links/);
	} finally { await rm(f.base, { recursive: true, force: true }); }
});

test("runtime failure quarantines one plugin and safe mode disables all plugins", async () => {
	const f = await fixture();
	try {
		const manager = new PluginManager({
			rootDir: join(f.base, "quarantine"), workspacesDir: f.workspacesDir, image: "unused", tenantId: "alice",
			executor: async () => { throw new Error("broken integration\nsecret detail"); },
		});
		await manager.install("capabilities/weather");
		await writeFile(join(f.source, "plugin.json"), JSON.stringify({ name: "weather", description: "Broken v2", entry: "broken.mjs" }));
		await writeFile(join(f.source, "broken.mjs"), "throw new Error('broken');\n");
		await manager.install("capabilities/weather");
		await assert.rejects(manager.invoke("weather", null), /failed and was disabled: broken integration secret detail/);
		assert.deepEqual(await manager.list().then((items) => items.map((item) => [item.name, item.status, item.error])), [
			["weather", "error", "broken integration secret detail"],
		]);
		const recoveredVersion = await manager.rollback("weather");
		assert.equal(recoveredVersion.description, "Weather lookup");
		assert.equal(recoveredVersion.status, "disabled");
		await assert.rejects(manager.invoke("weather", null), /disabled/);
		const safe = new PluginManager({
			rootDir: join(f.base, "quarantine"), workspacesDir: f.workspacesDir, image: "unused", tenantId: "alice", disabled: true,
			executor: async () => "should not run",
		});
		assert.equal((await safe.list())[0]?.status, "disabled");
		await assert.rejects(safe.enable("weather"), /safe mode/);
	} finally { await rm(f.base, { recursive: true, force: true }); }
});

test("aborting an invocation leaves a healthy plugin enabled", async () => {
	const f = await fixture();
	try {
		const controller = new AbortController();
		const manager = new PluginManager({
			rootDir: join(f.base, "cancelled"), workspacesDir: f.workspacesDir, image: "unused", tenantId: "alice",
			executor: async () => {
				controller.abort();
				throw new Error("plugin invocation aborted");
			},
		});
		await manager.install("capabilities/weather");
		await assert.rejects(manager.invoke("weather", null, controller.signal), /aborted/);
		assert.equal((await manager.list())[0]?.status, "enabled");
	} finally { await rm(f.base, { recursive: true, force: true }); }
});

test("malformed registry records are reported without blocking the manager", async () => {
	const f = await fixture();
	try {
		const rootDir = join(f.base, "malformed");
		await mkdir(rootDir, { recursive: true });
		await writeFile(join(rootDir, "plugins.json"), JSON.stringify({ plugins: {
			weather: { name: "weather", description: "Weather", entry: "main.mjs", version: "../../escape", history: [], enabled: true },
		} }));
		const manager = new PluginManager({ rootDir, workspacesDir: f.workspacesDir, image: "unused", tenantId: "alice", executor: async () => "unused" });
		const listed = await manager.list();
		assert.equal(listed[0]?.status, "error");
		assert.match(listed[0]?.error ?? "", /invalid plugin version/);
	} finally { await rm(f.base, { recursive: true, force: true }); }
});

test("Docker executor keeps stdin open for JSON input and passes it through", async () => {
	const base = await mkdtemp(join(tmpdir(), "crumble-fake-docker-"));
	const bin = join(base, "bin");
	const previousPath = process.env.PATH;
	try {
		await mkdir(bin);
		const docker = join(bin, "docker");
		await writeFile(docker, '#!/usr/bin/env node\nlet input = ""; for await (const chunk of process.stdin) input += chunk; process.stdout.write(JSON.stringify({ args: process.argv.slice(2), input }));\n');
		await chmod(docker, 0o755);
		process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
		const result = JSON.parse(await dockerPluginExecutor({ snapshotDir: "/plugin-snapshot", entry: "main.mjs", dataDir: "/plugin-data", image: "image", input: { hello: "world" } })) as { args: string[]; input: string };
		assert.ok(result.args.includes("-i"));
		assert.equal(result.input, '{"hello":"world"}');
	} finally {
		process.env.PATH = previousPath;
		await rm(base, { recursive: true, force: true });
	}
});

test("manager-owned storage symlinks are rejected", async () => {
	const f = await fixture();
	const outside = join(f.base, "outside");
	try {
		await mkdir(outside, { recursive: true });
		const rootLink = join(f.base, "root-link");
		await symlink(outside, rootLink);
		await assert.rejects(new PluginManager({ rootDir: rootLink, workspacesDir: f.workspacesDir, image: "unused", tenantId: "alice" }).list(), /plugin root must be a real directory/);

		const snapshotsRootLink = join(f.base, "snapshots-root-link");
		await mkdir(snapshotsRootLink, { recursive: true });
		await symlink(outside, join(snapshotsRootLink, "snapshots"));
		await assert.rejects(new PluginManager({ rootDir: snapshotsRootLink, workspacesDir: f.workspacesDir, image: "unused", tenantId: "alice" }).list(), /storage cannot contain symlinks/);

		const registryLink = join(f.base, "registry-link");
		await mkdir(registryLink, { recursive: true });
		await writeFile(join(outside, "registry-source.json"), JSON.stringify({ plugins: {} }));
		await symlink(join(outside, "registry-source.json"), join(registryLink, "plugins.json"));
		await assert.rejects(new PluginManager({ rootDir: registryLink, workspacesDir: f.workspacesDir, image: "unused", tenantId: "alice" }).list(), /storage cannot contain symlinks/);

		const dataLink = join(f.base, "data-link");
		await mkdir(join(dataLink, "data"), { recursive: true });
		await symlink(outside, join(dataLink, "data", "alice"));
		await assert.rejects(new PluginManager({ rootDir: dataLink, workspacesDir: f.workspacesDir, image: "unused", tenantId: "alice" }).list(), /storage cannot contain symlinks/);

		const snapshotLink = join(f.base, "snapshot-link");
		await mkdir(join(snapshotLink, "snapshots"), { recursive: true });
		await symlink(outside, join(snapshotLink, "snapshots", "weather"));
		const snapshotManager = new PluginManager({ rootDir: snapshotLink, workspacesDir: f.workspacesDir, image: "unused", tenantId: "alice", executor: async () => "unused" });
		await assert.rejects(snapshotManager.install("capabilities/weather"), /storage cannot contain symlinks/);
	} finally { await rm(f.base, { recursive: true, force: true }); }
});
