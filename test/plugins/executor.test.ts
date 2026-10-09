import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { dockerPluginExecutor } from "../../src/plugins/executor.ts";

async function fakeDocker(source: string): Promise<{ base: string; restore: () => void }> {
	const base = await mkdtemp(join(tmpdir(), "crumble-execa-docker-"));
	const bin = join(base, "bin");
	await mkdir(bin);
	const executable = join(bin, "docker");
	await writeFile(executable, `#!/usr/bin/env node\n${source}\n`);
	await chmod(executable, 0o755);
	const previousPath = process.env.PATH;
	process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
	return { base, restore: () => { process.env.PATH = previousPath; } };
}

test("plugin executor preserves raw stdout and does not inherit host secrets", async () => {
	const fake = await fakeDocker("if (process.argv[2] === 'run') { process.stdout.write((process.env.CRUMBLE_TEST_SECRET ?? 'missing-secret') + '\\n\\n'); }");
	const previousSecret = process.env.CRUMBLE_TEST_SECRET;
	process.env.CRUMBLE_TEST_SECRET = "host-secret";
	try {
		const result = await dockerPluginExecutor({ snapshotDir: "/snapshot", entry: "main.mjs", dataDir: "/data", image: "image", input: {} });
		assert.equal(result, "missing-secret\n\n");
	} finally {
		if (previousSecret === undefined) delete process.env.CRUMBLE_TEST_SECRET;
		else process.env.CRUMBLE_TEST_SECRET = previousSecret;
		fake.restore();
		await rm(fake.base, { recursive: true, force: true });
	}
});

test("plugin executor limits UTF-8 output by bytes", async () => {
	const fake = await fakeDocker("if (process.argv[2] === 'run') process.stdout.write('😀'.repeat(262_145));");
	try {
		await assert.rejects(
			dockerPluginExecutor({ snapshotDir: "/snapshot", entry: "main.mjs", dataDir: "/data", image: "image", input: {} }),
			/plugin output exceeds 1048576 bytes/,
		);
	} finally {
		fake.restore();
		await rm(fake.base, { recursive: true, force: true });
	}
});

test("plugin executor retains nonzero Docker diagnostics", async () => {
	const fake = await fakeDocker("if (process.argv[2] === 'run') { process.stderr.write('plugin failed\\n'); process.exit(7); }");
	try {
		await assert.rejects(
			dockerPluginExecutor({ snapshotDir: "/snapshot", entry: "main.mjs", dataDir: "/data", image: "image", input: {} }),
			/plugin failed/,
		);
	} finally {
		fake.restore();
		await rm(fake.base, { recursive: true, force: true });
	}
});

test("aborting a running plugin removes the container even when cleanup hangs", { timeout: 10_000 }, async () => {
	const base = await mkdtemp(join(tmpdir(), "crumble-execa-docker-cleanup-"));
	const marker = join(base, "cleanup-started");
	const started = join(base, "run-started");
	const fake = await fakeDocker(`const fs = require("node:fs");
if (process.argv[2] === "run") { fs.writeFileSync(${JSON.stringify(started)}, "started"); setInterval(() => {}, 1000); }
if (process.argv[2] === "rm") { fs.writeFileSync(${JSON.stringify(marker)}, process.env.CRUMBLE_TEST_SECRET ?? "missing-secret"); setInterval(() => {}, 1000); }`);
	const previousSecret = process.env.CRUMBLE_TEST_SECRET;
	process.env.CRUMBLE_TEST_SECRET = "host-secret";
	const controller = new AbortController();
	const invocation = dockerPluginExecutor({ snapshotDir: "/snapshot", entry: "main.mjs", dataDir: "/data", image: "image", input: {}, signal: controller.signal });
	try {
		const deadline = Date.now() + 3_000;
		while (!(await access(started).then(() => true, () => false)) && Date.now() < deadline) await delay(10);
		await access(started);
		controller.abort();
		await assert.rejects(invocation, /plugin invocation aborted/);
		await access(marker);
		assert.equal(await readFile(marker, "utf8"), "missing-secret");
	} finally {
		controller.abort();
		if (previousSecret === undefined) delete process.env.CRUMBLE_TEST_SECRET;
		else process.env.CRUMBLE_TEST_SECRET = previousSecret;
		fake.restore();
		await rm(base, { recursive: true, force: true });
		await rm(fake.base, { recursive: true, force: true });
	}
});
