import type { Inbox, InboundRequest } from "./inbox.ts";

export type AssistantReply = string | { text: string; notify: boolean };

export interface InboxOptions {
	inbox: Inbox;
	handle: (request: InboundRequest) => Promise<AssistantReply>;
	changed: () => void;
	activity?: (request: InboundRequest, active: boolean) => void;
	onError?: (error: unknown) => void;
}

/** Exactly one model turn per tenant. Queue and replies live in SQLite, not this object. */
export class InboxProcessor {
	private options: InboxOptions;
	private active: Promise<void> | undefined;
	private stopped = false;

	constructor(options: InboxOptions) {
		this.options = options;
	}

	wake(): Promise<void> {
		if (this.stopped) return Promise.resolve();
		if (!this.active) {
			this.active = this.drain().catch((error: unknown) => this.options.onError?.(error)).finally(() => {
				this.active = undefined;
			});
		}
		return this.active;
	}

	async close(): Promise<void> {
		this.stopped = true;
		await this.active;
	}

	private activity(request: InboundRequest, active: boolean): void {
		try { this.options.activity?.(request, active); }
		catch { /* Presence hints must not affect durable request processing. */ }
	}

	private async drain(): Promise<void> {
		const { inbox, handle, changed } = this.options;
		while (!this.stopped) {
			const request = inbox.nextPending();
			if (!request) break;
			if (!inbox.markProcessing(request.id)) continue;
			this.activity(request, true);
			try {
				const response = await handle(request);
				const text = typeof response === "string" ? response : response.text;
				inbox.complete(request.id, text.trim().slice(0, 1_000_000) || "The request finished without a text response.", typeof response === "string" ? true : response.notify);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				inbox.fail(request.id, reason.slice(0, 8_000) || "The request failed.");
			} finally {
				this.activity(request, false);
			}
			changed();
		}
	}
}
