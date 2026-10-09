import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Job } from "#jobs";
import { HostRunner } from "../../src/jobs/host-runner.ts";
import { resolveWorkspacePath, workerEnvironment, type RunnerDirs } from "../../src/jobs/runner.ts";
import { containerName } from "../../src/jobs/sandbox-runner.ts";

function withDirs(fn: (base: string, dirs: RunnerDirs) => void): void {
	const base = mkdtempSync(join(tmpdir(), "crumble-runner-"));
	const tenantRoot = join(base, "tenant");
	mkdirSync(tenantRoot, { recursive: true });
	const dirs: RunnerDirs = {
		id: "lea",
		rootDir: tenantRoot,
		homeDir: join(tenantRoot, "home"),
		agentDir: join(tenantRoot, "agent"),
		jobsDir: join(tenantRoot, "jobs"),
		workspacesDir: join(tenantRoot, "workspaces"),
	};
	try {
		fn(base, dirs);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
}

const job = (project: string, id = "abcd1234"): Job => ({
	id,
	project,
	brief: "",
	status: "running",
	question: null,
	summary: null,
	error: null,
	createdAt: 0,
	updatedAt: 0,
});

test("workspace and session paths are scoped to a tenant and reject traversal", () => {
	withDirs((_base, dirs) => {
		const workspace = resolveWorkspacePath(dirs, "personal");
		assert.equal(workspace, realpathSync(join(dirs.workspacesDir, "personal")));
		assert.ok(new HostRunner(dirs).sessionDir(job("personal")).startsWith(realpathSync(dirs.jobsDir)));
		assert.throws(() => resolveWorkspacePath(dirs, "../other"), /Invalid project name/);
		assert.throws(() => new HostRunner(dirs).sessionDir(job("personal", "../outside")), /Invalid job id/);
	});
});

test("workspace symlinks cannot escape the tenant root", () => {
	withDirs((base, dirs) => {
		const outside = join(base, "outside");
		mkdirSync(outside);
		mkdirSync(dirs.workspacesDir, { recursive: true });
		symlinkSync(outside, join(dirs.workspacesDir, "escape"), "dir");
		assert.throws(() => resolveWorkspacePath(dirs, "escape"), /symbolic link/);
		assert.deepEqual(readdirSync(outside), []);
	});
});

test("job session symlinks are rejected before writing outside the tenant", () => {
	withDirs((base, dirs) => {
		const outside = join(base, "outside");
		mkdirSync(outside);
		mkdirSync(dirs.jobsDir, { recursive: true });
		symlinkSync(outside, join(dirs.jobsDir, "abcd1234"), "dir");
		assert.throws(() => new HostRunner(dirs).sessionDir(job("personal")), /Job directory must not be a symbolic link/);
		assert.deepEqual(readdirSync(outside), []);
	});
});

test("sandbox identity includes tenant scope and full workspace location", () => {
	withDirs((base, dirs) => {
		const workspace = resolveWorkspacePath(dirs, "personal");
		const first = containerName(dirs, workspace, "personal");
		const otherTenant = containerName({ ...dirs, id: "alex" }, workspace, "personal");
		const otherWorkspace = containerName(dirs, join(base, "elsewhere", "personal"), "personal");
		assert.notEqual(first, otherTenant);
		assert.notEqual(first, otherWorkspace);
	});
});

test("worker environment carries tenant Pi paths and omits host/service secrets", () => {
	withDirs((_base, dirs) => {
		const env = workerEnvironment(dirs);
		assert.equal(env.HOME, dirs.homeDir);
		assert.equal(env.PI_CODING_AGENT_DIR, dirs.agentDir);
		assert.equal(env.OPENAI_API_KEY, undefined);
		assert.equal(env.DISCORD_TOKEN, undefined);
	});
});
