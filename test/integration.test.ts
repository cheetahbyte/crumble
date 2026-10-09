import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Inbox } from "../src/inbox/inbox.ts";
import { openDatabase } from "../src/db/database.ts";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const mainPath = join(repoRoot, "src", "main.ts");
const INTERRUPTED_REPLY = "Request was interrupted when the application stopped. It was not replayed automatically.";
const OUTPUT_LIMIT = 256_000;

interface RunningCrumble {
	process: ChildProcess;
	output(): string;
	waitFor(text: string, timeoutMs?: number): Promise<void>;
	stop(): Promise<void>;
}

function createConfig(directory: string): { configPath: string; dataDir: string } {
	const configPath = join(directory, "crumble.json");
	const dataDir = join(directory, "data");
	writeFileSync(configPath, JSON.stringify({
		dataDir: "data",
		provider: "openai",
		model: "gpt-6-luna",
		runner: "sandbox",
		tenants: [{ id: "alice" }, { id: "bob" }],
	}), "utf8");
	return { configPath, dataDir };
}

function startCrumble(configPath: string): RunningCrumble {
	const env = { ...process.env };
	for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "DISCORD_TOKEN"]) delete env[key];
	env.CRUMBLE_CONFIG = configPath;
	env.CRUMBLE_DISABLE_PLUGINS = "1";
	const child = spawn(process.execPath, [mainPath], {
		cwd: repoRoot,
		env,
		// No stdin is provided: the default app mode is a headless service.
		stdio: ["ignore", "pipe", "pipe"],
		detached: process.platform !== "win32",
	});
	let captured = "";
	const collect = (chunk: Buffer): void => {
		captured = (captured + chunk.toString("utf8")).slice(-OUTPUT_LIMIT);
	};
	child.stdout?.on("data", collect);
	child.stderr?.on("data", collect);
	return {
		process: child,
		output: () => captured,
		waitFor: async (text, timeoutMs = 15_000) => {
			const deadline = Date.now() + timeoutMs;
			while (!captured.includes(text)) {
				if (child.exitCode !== null || child.signalCode !== null) {
					throw new Error(`Crumble exited before output ${JSON.stringify(text)}. Output:\n${captured}`);
				}
				if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${JSON.stringify(text)}. Output:\n${captured}`);
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
		},
		stop: async () => {
			if (child.exitCode !== null || child.signalCode !== null) return;
			if (process.platform !== "win32" && child.pid) {
				try { process.kill(-child.pid, "SIGTERM"); } catch { /* Process group already exited. */ }
			} else child.kill("SIGTERM");
			if (!(await waitForExit(child, 10_000))) {
				if (process.platform !== "win32" && child.pid) {
					try { process.kill(-child.pid, "SIGKILL"); } catch { /* Process group already exited. */ }
				} else child.kill("SIGKILL");
				await waitForExit(child, 2_000);
			}
		},
	};
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
	return new Promise((resolve) => {
		const timer = setTimeout(() => finish(false), timeoutMs);
		const onExit = (): void => finish(true);
		function finish(exited: boolean): void {
			clearTimeout(timer);
			child.off("exit", onExit);
			resolve(exited);
		}
		child.once("exit", onExit);
	});
}

async function waitUntil(check: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for durable state");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

test("headless service persists tenant outboxes, enforces singleton, and releases its lock on shutdown", async () => {
	const directory = mkdtempSync(join(tmpdir(), "crumble-headless-service-"));
	const { configPath, dataDir } = createConfig(directory);
	const alicePath = join(dataDir, "tenants", "alice", "assistant.db");
	const bobPath = join(dataDir, "tenants", "bob", "assistant.db");
	mkdirSync(dirname(alicePath), { recursive: true });
	mkdirSync(dirname(bobPath), { recursive: true });
	const aliceSeedDb = openDatabase(alicePath, "assistant");
	const aliceSeed = new Inbox(aliceSeedDb);
	aliceSeed.enqueue({ id: "internal:alice-help", text: "/jobs", source: "internal" });
	aliceSeedDb.close();
	const bobSeedDb = openDatabase(bobPath, "assistant");
	const bobSeed = new Inbox(bobSeedDb);
	bobSeed.enqueue({ id: "internal:bob-help", text: "/jobs", source: "internal" });
	bobSeedDb.close();
	const aliceDb = openDatabase(alicePath, "assistant");
	const alice = new Inbox(aliceDb);
	const bobDb = openDatabase(bobPath, "assistant");
	const bob = new Inbox(bobDb);
	let crumble: RunningCrumble | undefined;
	try {
		crumble = startCrumble(configPath);
		await crumble.waitFor("Crumble service ready for 2 tenants");
		await waitUntil(() => alice.get("internal:alice-help")?.status === "completed" && bob.get("internal:bob-help")?.status === "completed");
		assert.match(alice.pendingDeliveries()[0]?.response ?? "", /No jobs yet/);
		assert.match(bob.pendingDeliveries()[0]?.response ?? "", /No jobs yet/);
		assert.doesNotMatch(crumble.output(), /No jobs yet/);
		assert.equal(existsSync(join(dataDir, "service.lock")), true);

		const contender = startCrumble(configPath);
		assert.equal(await waitForExit(contender.process, 5_000), true, "a second service must exit while the first owns the data directory");
		assert.match(contender.output(), /already running/);
		await crumble.stop();
		crumble = undefined;
		assert.equal(existsSync(join(dataDir, "service.lock")), false, "graceful shutdown should release the service lock");

		crumble = startCrumble(configPath);
		await crumble.waitFor("Crumble service ready for 2 tenants");
		assert.equal(alice.pendingDeliveries().length, 1, "headless mode must preserve terminal/internal deliveries until a channel can deliver them");
		assert.equal(bob.pendingDeliveries().length, 1);
	} finally {
		await crumble?.stop();
		aliceDb.close();
		bobDb.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("headless restart recovers interrupted work without replaying or acknowledging terminal deliveries", async () => {
	const directory = mkdtempSync(join(tmpdir(), "crumble-headless-recovery-"));
	const { configPath, dataDir } = createConfig(directory);
	const aliceStatePath = join(dataDir, "tenants", "alice", "assistant.db");
	mkdirSync(dirname(aliceStatePath), { recursive: true });
	const aliceSeedDb = openDatabase(aliceStatePath, "assistant");
	const aliceSeed = new Inbox(aliceSeedDb);
	aliceSeed.enqueue({ id: "terminal:interrupted-before-boot", text: "DO_NOT_SEND_TO_A_MODEL", source: "terminal" });
	aliceSeed.markProcessing("terminal:interrupted-before-boot");
	aliceSeedDb.close();
	let crumble: RunningCrumble | undefined;
	try {
		crumble = startCrumble(configPath);
		await crumble.waitFor("Crumble service ready for 2 tenants");
		await waitUntil(() => {
			const stateDb = openDatabase(aliceStatePath, "assistant");
			const inbox = new Inbox(stateDb);
			try { return inbox.get("terminal:interrupted-before-boot")?.status === "failed"; }
			finally { stateDb.close(); }
		});
		assert.doesNotMatch(crumble.output(), /DO_NOT_SEND_TO_A_MODEL|Request was interrupted/);
		await crumble.stop();
		crumble = undefined;

		const recoveredDb = openDatabase(aliceStatePath, "assistant");
		const recovered = new Inbox(recoveredDb);
		try {
			assert.equal(recovered.get("terminal:interrupted-before-boot")?.status, "failed");
			assert.deepEqual(recovered.pendingDeliveries().map(({ id, source }) => ({ id, source })), [
				{ id: "terminal:interrupted-before-boot", source: "terminal" },
			]);
			assert.equal(recovered.pendingDeliveries()[0]?.response, INTERRUPTED_REPLY);
		} finally { recoveredDb.close(); }
	} finally {
		await crumble?.stop();
		rmSync(directory, { recursive: true, force: true });
	}
});
