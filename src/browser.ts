import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { execa } from "execa";

const MAX_RESPONSE_BYTES = 512_000;
const ACTION_TIMEOUT_MS = 45_000;
const START_TIMEOUT_MS = 30_000;

export type BrowserLocator =
	| { by: "role"; role: string; name?: string; exact?: boolean }
	| { by: "label" | "placeholder" | "text"; value: string; exact?: boolean }
	| { by: "css"; value: string };

export type BrowserAction =
	| { action: "navigate"; url: string }
	| { action: "snapshot" }
	| { action: "click"; locator: BrowserLocator }
	| { action: "fill"; locator: BrowserLocator; value: string }
	| { action: "press"; locator: BrowserLocator; key: string }
	| { action: "back" }
	| { action: "screenshot" };

export interface BrowserManagerOptions {
	tenantId: string;
	rootDir: string;
	image?: string;
	testFixture?: boolean;
}

function docker(args: string[], input?: string, signal?: AbortSignal, timeoutMs = START_TIMEOUT_MS): Promise<Buffer> {
	if (signal?.aborted) return Promise.reject(new Error("aborted"));
	const stderrChunks: Buffer[] = [];
	let stderrBytes = 0;
	const command = execa("docker", args, {
		input: input ?? "",
		cwd: process.cwd(),
		encoding: "buffer",
		stripFinalNewline: false,
		buffer: { stdout: true, stderr: false },
		maxBuffer: { stdout: MAX_RESPONSE_BYTES, stderr: 100_000_000 },
		cancelSignal: signal,
		timeout: timeoutMs,
		forceKillAfterDelay: 1_000,
	});
	command.stderr?.on("data", (chunk: Buffer) => {
		const remaining = 16_000 - stderrBytes;
		if (remaining > 0) {
			stderrChunks.push(chunk.subarray(0, remaining));
			stderrBytes += Math.min(chunk.length, remaining);
		}
	});
	return command.then(({ stdout }) => Buffer.from(stdout as Uint8Array)).catch((error: unknown) => {
		const result = error as { isCanceled?: boolean; timedOut?: boolean; isMaxBuffer?: boolean; stderr?: Uint8Array; message?: string };
		if (result.isCanceled) throw new Error("aborted");
		if (result.timedOut) throw new Error("browser docker command timed out");
		if (result.isMaxBuffer) throw new Error("browser response exceeded the output limit");
		const diagnostic = Buffer.concat(stderrChunks).toString().trim();
		throw new Error(diagnostic || result.message || "docker command failed");
	});
}

async function isSymlink(path: string): Promise<boolean> {
	try { return (await lstat(path)).isSymbolicLink(); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/** Owns one persistent headless browser container and profile for a tenant. */
export class BrowserManager {
	readonly tenantId: string;
	readonly rootDir: string;
	readonly image: string;
	readonly containerName: string;
	private readonly testFixture: boolean;
	private profileDir?: string;
	private requestToken?: string;
	private starting?: Promise<void>;
	private queue: Promise<unknown> = Promise.resolve();
	private closed = false;
	private started = false;
	private readonly lifecycle = new AbortController();
	private inFlight?: { id: string; cancel: () => void };

	constructor(options: BrowserManagerOptions) {
		this.tenantId = options.tenantId;
		this.rootDir = resolve(options.rootDir);
		this.image = options.image ?? "crumble-browser";
		this.testFixture = options.testFixture ?? false;
		const suffix = createHash("sha256").update(`${options.tenantId}\0${this.rootDir}`).digest("hex").slice(0, 20);
		this.containerName = `crumble-browser-${suffix}`;
	}

	private async ensureProfile(): Promise<string> {
		if (this.profileDir) return this.profileDir;
		await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
		if (await isSymlink(this.rootDir)) throw new Error("browser profile root must not be a symlink");
		const root = await realpath(this.rootDir);
		const profile = resolve(root, "browser");
		if (await isSymlink(profile)) throw new Error("browser profile directory must not be a symlink");
		await mkdir(profile, { recursive: true, mode: 0o700 });
		const stat = await lstat(profile);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("browser profile path is not a safe directory");
		this.profileDir = profile;
		const tokenPath = resolve(profile, ".request-token");
		if (await isSymlink(tokenPath)) throw new Error("browser request token must not be a symlink");
		try {
			this.requestToken = await readFile(tokenPath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			this.requestToken = randomUUID();
			try {
				const file = await open(tokenPath, "wx", 0o600);
				await file.writeFile(this.requestToken, "utf8");
				await file.close();
			} catch (writeError) {
				if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
				this.requestToken = await readFile(tokenPath, "utf8");
			}
		}
		return profile;
	}

	private ensureRunning(signal?: AbortSignal): Promise<void> {
		if (this.closed) return Promise.reject(new Error("browser manager is closed"));
		if (!this.starting) {
			this.starting = this.startContainer(signal).finally(() => { this.starting = undefined; });
		}
		return this.starting;
	}

	private async inspectContainer(profile: string, signal?: AbortSignal): Promise<{ imageId: string } | undefined> {
		try {
			const output = await docker(["container", "inspect", "--format", "{{json .}}", this.containerName], undefined, signal);
			const parsed = JSON.parse(output.toString());
			const info = (Array.isArray(parsed) ? parsed[0] : parsed) as { Image?: string; Config?: { Env?: string[]; Labels?: Record<string, string> }; Mounts?: Array<{ Source?: string; Destination?: string }> };
			const labels = info.Config?.Labels ?? {};
			const env = info.Config?.Env ?? [];
			const hasToken = env.includes(`CRUMBLE_BROWSER_TOKEN=${this.requestToken}`);
			if (labels["crumble.managed"] !== "browser" || labels["crumble.tenant"] !== createHash("sha256").update(this.tenantId).digest("hex") ||
				!info.Mounts?.some((mount) => mount.Source === profile && mount.Destination === "/profile") || !hasToken) {
				throw new Error("an existing browser container does not match this tenant profile; remove it before retrying");
			}
			return { imageId: info.Image ?? "" };
		} catch (error) {
			if (/does not match this tenant profile/.test(String(error))) throw error;
			if (signal?.aborted) throw new Error("aborted");
			if (/No such (object|container)/.test(String(error))) return undefined;
			throw error;
		}
	}

	private async startContainer(signal?: AbortSignal): Promise<void> {
		const profile = await this.ensureProfile();
		let existing = await this.inspectContainer(profile, signal);
		if (existing) {
			this.started = true;
			const desiredImage = (await docker(["image", "inspect", "--format", "{{.Id}}", this.image], undefined, signal)).toString().trim();
			if (existing.imageId !== desiredImage) {
				await docker(["stop", "--time", "10", this.containerName], undefined, signal, 15_000);
				await docker(["rm", this.containerName], undefined, signal);
				this.started = false;
				existing = undefined;
			} else {
				await docker(["start", this.containerName], undefined, signal).catch((error) => {
					if (!/already running/.test(String(error))) throw error;
				});
			}
		}
		if (!existing) {
			try {
				await docker([
					"run", "-d", "--name", this.containerName,
					"--label", "crumble.managed=browser",
					"--label", `crumble.tenant=${createHash("sha256").update(this.tenantId).digest("hex")}`,
					...(this.testFixture ? ["--env", "CRUMBLE_BROWSER_TEST_FIXTURE=1"] : []),
					"--env", `CRUMBLE_BROWSER_TOKEN=${this.requestToken}`,
					"--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=256", "--memory=1g",
					"--mount", `type=bind,src=${profile},dst=/profile`,
					this.image,
				], undefined, signal);
				this.started = true;
			} catch (error) {
				if (!/Conflict|already in use/.test(String(error)) || !await this.inspectContainer(profile, signal)) throw error;
				this.started = true;
			}
		}
		const until = Date.now() + START_TIMEOUT_MS;
		while (Date.now() < until) {
			if (signal?.aborted) throw new Error("aborted");
			try {
				const response = await docker(["exec", "-i", this.containerName, "node", "/opt/crumble/browser-client.mjs"], JSON.stringify({ health: true }), signal, 3_000);
				if (JSON.parse(response.toString()).ok) return;
			} catch { /* Server is starting. */ }
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
		}
		throw new Error("browser server did not become ready");
	}

	act(action: BrowserAction, signal?: AbortSignal): Promise<unknown> {
		const run = async () => {
			const actionSignal = signal ? AbortSignal.any([signal, this.lifecycle.signal]) : this.lifecycle.signal;
			if (actionSignal.aborted) throw new Error("aborted");
			await this.ensureRunning(actionSignal);
			if (actionSignal.aborted) throw new Error("aborted");
			const id = randomUUID();
			const cancel = () => {
				void docker(
					["exec", "-i", this.containerName, "node", "/opt/crumble/browser-client.mjs"],
					JSON.stringify({ cancel: id }), undefined, 5_000,
				).catch(() => undefined);
			};
			this.inFlight = { id, cancel };
			actionSignal.addEventListener("abort", cancel, { once: true });
			try {
				const result = await docker(
					["exec", "-i", this.containerName, "node", "/opt/crumble/browser-client.mjs"],
					JSON.stringify({ id, action }), actionSignal, ACTION_TIMEOUT_MS,
				);
				const parsed = JSON.parse(result.toString());
				if (!parsed.ok) throw new Error(parsed.error ?? "browser action failed");
				this.started = true;
				return parsed.result;
			} finally {
				actionSignal.removeEventListener("abort", cancel);
				if (this.inFlight?.id === id) this.inFlight = undefined;
			}
		};
		const result = this.queue.then(run, run);
		this.queue = result.catch(() => undefined);
		return result;
	}

	async close(): Promise<void> {
		this.closed = true;
		const mayOwnContainer = this.started || this.starting !== undefined;
		this.lifecycle.abort();
		if (!mayOwnContainer) return;
		this.inFlight?.cancel();
		await this.queue.catch(() => undefined);
		if (!this.started && this.profileDir) {
			try { this.started = !!await this.inspectContainer(this.profileDir); }
			catch { return; }
		}
		if (!this.started) return;
		try {
			await docker(["stop", "--time", "10", this.containerName], undefined, undefined, 15_000);
		} catch (error) {
			if (!/No such container/.test(String(error))) throw error;
		}
	}
}
