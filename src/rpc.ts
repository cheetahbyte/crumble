import type { ChildProcessWithoutNullStreams } from "node:child_process";

export interface RpcRecord {
	type: string;
	[key: string]: unknown;
}

interface Pending {
	resolve: (data: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

const DIALOG_METHODS: readonly string[] = ["select", "confirm", "input", "editor"];

// Pi's RPC framing splits on LF only; U+2028/U+2029 are valid inside JSON strings.
export function splitRecords(buffer: string, chunk: string): { lines: string[]; rest: string } {
	const parts = (buffer + chunk).split("\n");
	const rest = parts.pop() ?? "";
	const lines = parts.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line)).filter((line) => line.length > 0);
	return { lines, rest };
}

export interface PiRpcOptions {
	requestTimeoutMs?: number;
	closeGraceMs?: number;
}

// Pi's packaged RpcClient owns spawning and merges the host environment. This adapter
// accepts a tenant-scoped child from our runner and keeps request/teardown deadlines.
export class PiRpc {
	readonly exited: Promise<number | null>;
	readonly failure: Promise<Error | null>;
	private child: ChildProcessWithoutNullStreams;
	private buffer = "";
	private nextId = 0;
	private stderrTail = "";
	private pending = new Map<string, Pending>();
	private listeners = new Set<(record: RpcRecord) => void>();
	private requestTimeoutMs: number;
	private closeGraceMs: number;
	private failedError: Error | null = null;
	private resolveFailure!: (error: Error | null) => void;
	private exitedResolve!: (code: number | null) => void;
	private closing: Promise<number | null> | null = null;

	constructor(child: ChildProcessWithoutNullStreams, options: PiRpcOptions = {}) {
		this.child = child;
		this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
		this.closeGraceMs = options.closeGraceMs ?? 2_000;
		this.exited = new Promise((resolve) => (this.exitedResolve = resolve));
		this.failure = new Promise((resolve) => (this.resolveFailure = resolve));
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.feed(chunk));
		child.stdout.on("error", (error) => this.fail(error));
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			this.stderrTail = (this.stderrTail + chunk).slice(-2000);
		});
		child.stderr.on("error", (error) => this.fail(error));
		child.stdin.on("error", (error) => this.fail(error));
		child.on("error", (error) => {
			this.fail(error);
			this.exitedResolve(null);
		});
		child.on("exit", (code) => {
			this.resolveFailure(null);
			this.failPending(new Error(`worker exited with code ${code}`));
			this.exitedResolve(code);
		});
	}

	get stderr(): string {
		return this.stderrTail;
	}

	get error(): Error | null {
		return this.failedError;
	}

	onEvent(listener: (record: RpcRecord) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	request(command: RpcRecord, timeoutMs = this.requestTimeoutMs): Promise<unknown> {
		if (this.failedError) return Promise.reject(this.failedError);
		const id = `req-${++this.nextId}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`RPC request ${command.type} timed out after ${timeoutMs} ms`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.write({ ...command, id });
		});
	}

	async close(graceMs = this.closeGraceMs): Promise<number | null> {
		if (this.closing) return this.closing;
		this.closing = this.closeBounded(graceMs);
		return this.closing;
	}

	async terminate(graceMs = 500): Promise<number | null> {
		if (this.closing) return this.closing;
		this.closing = this.terminateBounded(graceMs);
		return this.closing;
	}

	private async closeBounded(graceMs: number): Promise<number | null> {
		if (this.child.exitCode !== null || this.child.signalCode !== null) return this.exited;
		try {
			this.child.stdin.end();
		} catch (error) {
			this.fail(error instanceof Error ? error : new Error(String(error)));
		}
		return this.waitThenKill(graceMs);
	}

	private async terminateBounded(graceMs: number): Promise<number | null> {
		if (this.child.exitCode !== null || this.child.signalCode !== null) return this.exited;
		try {
			this.child.kill("SIGTERM");
		} catch (error) {
			this.fail(error instanceof Error ? error : new Error(String(error)));
		}
		return this.waitThenKill(graceMs);
	}

	private async waitThenKill(graceMs: number): Promise<number | null> {
		let timer: NodeJS.Timeout;
		const outcome = await Promise.race([
			this.exited.then((code) => ({ code })),
			new Promise<{ timeout: true }>((resolve) => {
				timer = setTimeout(() => resolve({ timeout: true }), Math.max(0, graceMs));
			}),
		]);
		clearTimeout(timer!);
		if ("code" in outcome) return outcome.code;
		try {
			this.child.kill("SIGTERM");
		} catch {}
		const second = await Promise.race([
			this.exited.then((code) => ({ code })),
			new Promise<{ timeout: true }>((resolve) => {
				timer = setTimeout(() => resolve({ timeout: true }), 500);
			}),
		]);
		clearTimeout(timer!);
		if ("code" in second) return second.code;
		try {
			this.child.kill("SIGKILL");
		} catch {}
		return this.exited;
	}

	private write(record: RpcRecord): void {
		if (this.child.stdin.destroyed || this.child.stdin.writableEnded) {
			this.fail(new Error("worker stdin is closed"));
			return;
		}
		try {
			this.child.stdin.write(`${JSON.stringify(record)}\n`, (error) => {
				if (error) this.fail(error);
			});
		} catch (error) {
			this.fail(error instanceof Error ? error : new Error(String(error)));
		}
	}

	private feed(chunk: string): void {
		try {
			const { lines, rest } = splitRecords(this.buffer, chunk);
			this.buffer = rest;
			for (const line of lines) this.handle(JSON.parse(line) as RpcRecord);
		} catch (error) {
			this.fail(new Error(`invalid worker RPC JSON: ${error instanceof Error ? error.message : String(error)}`));
			try {
				this.child.kill("SIGTERM");
			} catch {}
		}
	}

	private handle(record: RpcRecord): void {
		if (record === null || typeof record !== "object" || typeof record.type !== "string") {
			this.fail(new Error("invalid worker RPC record"));
			return;
		}
		if (record.type === "response") {
			const pending = typeof record.id === "string" ? this.pending.get(record.id) : undefined;
			if (!pending || typeof record.id !== "string") return;
			this.pending.delete(record.id);
			clearTimeout(pending.timer);
			if (record.success === true) pending.resolve(record.data);
			else pending.reject(new Error(String(record.error ?? "RPC command failed")));
			return;
		}
		if (record.type === "extension_ui_request") {
			if (typeof record.method === "string" && DIALOG_METHODS.includes(record.method)) {
				this.write({ type: "extension_ui_response", id: record.id, cancelled: true });
			}
			return;
		}
		for (const listener of this.listeners) listener(record);
	}

	private fail(error: Error): void {
		if (this.failedError) return;
		this.failedError = error;
		this.resolveFailure(error);
		this.failPending(error);
	}

	private failPending(error: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}
}
