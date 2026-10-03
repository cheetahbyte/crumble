import type { ChildProcessWithoutNullStreams } from "node:child_process";

export interface RpcRecord {
	type: string;
	[key: string]: unknown;
}

interface Pending {
	resolve: (data: unknown) => void;
	reject: (error: Error) => void;
}

const DIALOG_METHODS: readonly string[] = ["select", "confirm", "input", "editor"];

// Pi's RPC framing splits on LF only; U+2028/U+2029 are valid inside JSON strings.
export function splitRecords(buffer: string, chunk: string): { lines: string[]; rest: string } {
	const parts = (buffer + chunk).split("\n");
	const rest = parts.pop() ?? "";
	const lines = parts.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line)).filter((line) => line.length > 0);
	return { lines, rest };
}

export class PiRpc {
	readonly exited: Promise<number | null>;
	private child: ChildProcessWithoutNullStreams;
	private buffer = "";
	private nextId = 0;
	private stderrTail = "";
	private pending = new Map<string, Pending>();
	private listeners = new Set<(record: RpcRecord) => void>();

	constructor(child: ChildProcessWithoutNullStreams) {
		this.child = child;
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.feed(chunk));
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			this.stderrTail = (this.stderrTail + chunk).slice(-2000);
		});
		this.exited = new Promise((resolve) => {
			child.on("error", (error) => {
				this.failPending(error);
				resolve(null);
			});
			child.on("exit", (code) => {
				this.failPending(new Error(`worker exited with code ${code}`));
				resolve(code);
			});
		});
	}

	get stderr(): string {
		return this.stderrTail;
	}

	onEvent(listener: (record: RpcRecord) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	request(command: RpcRecord): Promise<unknown> {
		const id = `req-${++this.nextId}`;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.write({ ...command, id });
		});
	}

	async close(): Promise<number | null> {
		this.child.stdin.end();
		return this.exited;
	}

	private write(record: RpcRecord): void {
		this.child.stdin.write(`${JSON.stringify(record)}\n`);
	}

	private feed(chunk: string): void {
		const { lines, rest } = splitRecords(this.buffer, chunk);
		this.buffer = rest;
		for (const line of lines) this.handle(JSON.parse(line) as RpcRecord);
	}

	private handle(record: RpcRecord): void {
		if (record.type === "response") {
			const pending = typeof record.id === "string" ? this.pending.get(record.id) : undefined;
			if (!pending || typeof record.id !== "string") return;
			this.pending.delete(record.id);
			if (record.success === true) pending.resolve(record.data);
			else pending.reject(new Error(String(record.error ?? "RPC command failed")));
			return;
		}
		if (record.type === "extension_ui_request") {
			// No human is attached to a worker; questions go through the ask tool instead.
			if (typeof record.method === "string" && DIALOG_METHODS.includes(record.method)) {
				this.write({ type: "extension_ui_response", id: record.id, cancelled: true });
			}
			return;
		}
		for (const listener of this.listeners) listener(record);
	}

	private failPending(error: Error): void {
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}
}
