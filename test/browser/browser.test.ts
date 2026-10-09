import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { BrowserManager } from "../../src/browser/browser.ts";

test("tenant browser profile rejects a symlink", async () => {
	const dir = await mkdtemp(join(tmpdir(), "crumble-browser-profile-"));
	const outside = join(dir, "outside");
	const tenantRoot = join(dir, "tenant");
	await mkdir(outside);
	await mkdir(tenantRoot);
	await symlink(outside, join(tenantRoot, "browser"));
	const manager = new BrowserManager({ tenantId: "profile-test", rootDir: tenantRoot });
	try {
		await assert.rejects(manager.act({ action: "snapshot" }), /browser profile directory must not be a symlink/);
		await assert.rejects(lstat(join(outside, "browser")));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("aborted browser action does not launch Docker", async () => {
	const manager = new BrowserManager({ tenantId: "abort-test", rootDir: join(tmpdir(), "never-created-browser-profile") });
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(manager.act({ action: "snapshot" }, controller.signal), /aborted/);
});

test("browser Docker output preserves trailing newlines and bounds stderr diagnostics", async () => {
	const base = await mkdtemp(join(tmpdir(), "crumble-browser-execa-"));
	const bin = join(base, "bin");
	await mkdir(bin);
	const docker = join(bin, "docker");
	await writeFile(docker, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "container") { process.stderr.write("No such container\\n" + "e".repeat(20_000)); process.exit(1); }
if (args[0] === "image") { process.stdout.write("image-id\\n"); process.exit(0); }
if (args[0] === "run") { process.stdout.write("container-id\\n"); process.exit(0); }
if (args[0] === "exec") { let input = ""; process.stdin.on("data", chunk => input += chunk); process.stdin.on("end", () => { const request = JSON.parse(input); process.stdout.write(request.health ? JSON.stringify({ok: true}) : JSON.stringify({ok: true, result: "raw\\n"})); }); }
if (args[0] === "stop") process.exit(0);
`);
	await chmod(docker, 0o755);
	const previousPath = process.env.PATH;
	process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
	const manager = new BrowserManager({ tenantId: "execa-browser", rootDir: join(base, "profile"), image: "image" });
	try {
		assert.equal(await manager.act({ action: "snapshot" }), "raw\n");
	} finally {
		await manager.close();
		process.env.PATH = previousPath;
		await rm(base, { recursive: true, force: true });
	}
});

test("browser Docker smoke: actions, profile persistence and tenant isolation", { timeout: 120_000 }, async (t) => {
	const image = process.env.CRUMBLE_BROWSER_TEST_IMAGE ?? "crumble-browser";
	if (spawnSync("docker", ["image", "inspect", image], { stdio: "ignore" }).status !== 0) {
		t.skip(`Docker image ${image} is unavailable`);
		return;
	}
	const base = await mkdtemp(join(tmpdir(), "crumble-browser-smoke-"));
	const tenantA = "browser-smoke-a-" + process.pid;
	const tenantB = "browser-smoke-b-" + process.pid;
	const managerA = new BrowserManager({ tenantId: tenantA, rootDir: join(base, "a"), image, testFixture: true });
	const managerB = new BrowserManager({ tenantId: tenantB, rootDir: join(base, "b"), image, testFixture: true });
	const fixtureUrl = "http://127.0.0.1:4173/fixture";
	try {
		const first = await managerA.act({ action: "navigate", url: `${fixtureUrl}/set` }) as { text: string; links: unknown[]; controls: unknown[] };
		assert.match(first.text, /Ready/);
		assert.ok(first.controls.length > 0);
		await managerA.act({ action: "fill", locator: { by: "placeholder", value: "Your name" }, value: "Ada" });
		const clicked = await managerA.act({ action: "click", locator: { by: "role", role: "button", name: "Save" } }) as { text: string };
		assert.match(clicked.text, /Hello Ada/);
		await managerA.close();

		const resumed = new BrowserManager({ tenantId: tenantA, rootDir: join(base, "a"), image, testFixture: true });
		const cookie = await resumed.act({ action: "navigate", url: `${fixtureUrl}/cookies` }) as { text: string };
		assert.match(cookie.text, /browser_smoke=stored/);
		const isolated = await managerB.act({ action: "navigate", url: `${fixtureUrl}/cookies` }) as { text: string };
		assert.doesNotMatch(isolated.text, /browser_smoke=stored/);
		await resumed.close();
		await managerB.close();
	} finally {
		for (const name of [managerA.containerName, managerB.containerName]) spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
		await rm(base, { recursive: true, force: true });
	}
});
