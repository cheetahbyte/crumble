import { ChannelType, Client, Events, GatewayIntentBits, Partials } from "discord.js";
import type { Channel, ChannelInput, ChannelMessageHandler } from "./channels.ts";

type IncomingMessage = {
	author: { id: string; bot: boolean };
	channel: { id: string; type: number };
	content: string;
	id: string;
};

type SendOptions = { content: string; allowedMentions: { parse: [] } };

type DiscordDM = {
	send(options: SendOptions): Promise<unknown>;
	sendTyping(): Promise<void>;
};

type DiscordUser = {
	createDM(): Promise<DiscordDM>;
};

type DiscordClient = {
	on(event: "messageCreate", listener: (message: IncomingMessage) => void): unknown;
	on(event: typeof Events.ClientReady | "error", listener: (...args: unknown[]) => void): unknown;
	off(event: "messageCreate", listener: (message: IncomingMessage) => void): unknown;
	off(event: typeof Events.ClientReady | "error", listener: (...args: unknown[]) => void): unknown;
	login(token: string): Promise<unknown>;
	destroy(): void;
	users: { fetch(userId: string): Promise<DiscordUser> };
};

export type DiscordChannelOptions = {
	token: string;
	/** Maps each tenant to the one Discord account permitted to use it. */
	tenantUsers: Readonly<Record<string, string>>;
	onMessage: ChannelMessageHandler;
	onError?: (error: Error) => void;
	/** Test seam. Production uses a discord.js client configured for DMs only. */
	createClient?: () => DiscordClient;
	/** Maximum time to wait for the initial Discord ready event. Defaults to 30 seconds. */
	readyTimeoutMs?: number;
	/** Test seam. Production refreshes Discord typing every 8 seconds. */
	typingRefreshMs?: number;
};

const MAX_MESSAGE_UNITS = 2000;

/** Split by grapheme while measuring Discord's UTF-16 content limit. */
function splitMessage(text: string): string[] {
	const chunks: string[] = [];
	let chunk = "";
	let units = 0;
	const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

	for (const { segment } of segmenter.segment(text)) {
		if (segment.length > MAX_MESSAGE_UNITS) {
			for (const point of segment) {
				if (units + point.length > MAX_MESSAGE_UNITS && chunk.length > 0) {
					chunks.push(chunk);
					chunk = "";
					units = 0;
				}
				chunk += point;
				units += point.length;
			}
			continue;
		}
		if (units + segment.length > MAX_MESSAGE_UNITS && chunk.length > 0) {
			chunks.push(chunk);
			chunk = "";
			units = 0;
		}
		chunk += segment;
		units += segment.length;
	}
	if (chunk.length > 0) chunks.push(chunk);
	return chunks;
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error("Discord operation failed");
}

type TypingState = { timer?: ReturnType<typeof setInterval>; inFlight: boolean };

export class DiscordChannel implements Channel {
	readonly kind = "discord";
	private readonly options: DiscordChannelOptions;
	private readonly client: DiscordClient;
	private readonly userTenants = new Map<string, string>();
	private readonly tenantUsers = new Map<string, string>();
	private readonly readyTimeoutMs: number;
	private readonly typingRefreshMs: number;
	private readonly typingByTenant = new Map<string, TypingState>();
	private started = false;
	private closed = false;
	private starting: Promise<void> | undefined;
	private rejectStarting: ((error: Error) => void) | undefined;
	private readyListener: ((...args: unknown[]) => void) | undefined;
	private readyTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(options: DiscordChannelOptions) {
		this.options = options;
		for (const [tenantId, userId] of Object.entries(options.tenantUsers)) {
			if (!tenantId || !userId) throw new Error("Discord tenant and user IDs must be non-empty");
			if (this.userTenants.has(userId)) throw new Error("A Discord user can only be assigned to one tenant");
			this.userTenants.set(userId, tenantId);
			this.tenantUsers.set(tenantId, userId);
		}
		this.readyTimeoutMs = options.readyTimeoutMs ?? 30_000;
		if (!Number.isSafeInteger(this.readyTimeoutMs) || this.readyTimeoutMs < 1 || this.readyTimeoutMs > 2_147_483_647) {
			throw new Error("Discord readyTimeoutMs must be a positive integer no greater than 2147483647");
		}
		this.typingRefreshMs = options.typingRefreshMs ?? 8_000;
		if (!Number.isSafeInteger(this.typingRefreshMs) || this.typingRefreshMs < 1 || this.typingRefreshMs > 2_147_483_647) {
			throw new Error("Discord typingRefreshMs must be a positive integer no greater than 2147483647");
		}
		this.client = options.createClient?.() ?? (new Client({
			intents: [GatewayIntentBits.DirectMessages],
			partials: [Partials.Channel],
			allowedMentions: { parse: [] },
		}) as unknown as DiscordClient);
		this.client.on("messageCreate", this.onMessage);
		this.client.on("error", this.onClientError);
	}

	start(): Promise<void> {
		if (this.closed) return Promise.reject(new Error("Discord channel is closed"));
		if (this.started) return Promise.resolve();
		if (this.starting) return this.starting;

		this.starting = new Promise<void>((resolve, reject) => {
			const fail = (error: Error) => {
				if (!this.rejectStarting) return;
				const rejectStart = this.rejectStarting;
				this.clearReadyTimer();
				this.clearReadyListener();
				for (const tenantId of this.typingByTenant.keys()) this.stopTyping(tenantId);
				this.rejectStarting = undefined;
				this.client.off("messageCreate", this.onMessage);
				this.client.off("error", this.onClientError);
				this.closed = true;
				this.client.destroy();
				rejectStart(error);
			};
			const ready = () => {
				this.clearReadyTimer();
				this.clearReadyListener();
				this.rejectStarting = undefined;
				this.started = true;
				resolve();
			};
			this.readyListener = ready;
			this.rejectStarting = reject;
			this.client.on(Events.ClientReady, ready);
			this.readyTimer = setTimeout(
				() => fail(new Error(`Discord client did not become ready within ${this.readyTimeoutMs}ms`)),
				this.readyTimeoutMs,
			);
			void this.client.login(this.options.token).catch((error: unknown) => fail(asError(error)));
		}).finally(() => {
			this.starting = undefined;
		});
		return this.starting;
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		for (const tenantId of this.typingByTenant.keys()) this.stopTyping(tenantId);
		this.client.off("messageCreate", this.onMessage);
		this.client.off("error", this.onClientError);
		this.clearReadyTimer();
		this.clearReadyListener();
		this.rejectStarting?.(new Error("Discord channel closed before becoming ready"));
		this.readyListener = undefined;
		this.rejectStarting = undefined;
		this.client.destroy();
	}

	serves(tenantId: string): boolean {
		return this.tenantUsers.has(tenantId);
	}

	async send(tenantId: string, text: string): Promise<void> {
		if (!this.started || this.closed) throw new Error("Discord channel is not running");
		const userId = this.tenantUsers.get(tenantId);
		if (!userId) throw new Error(`No Discord user is configured for tenant ${tenantId}`);
		const chunks = splitMessage(text);
		if (chunks.length === 0) return;
		const user = await this.client.users.fetch(userId);
		const dm = await user.createDM();
		for (const content of chunks) {
			await dm.send({ content, allowedMentions: { parse: [] } });
		}
	}

	setTyping(tenantId: string, active: boolean): void {
		if (!active) {
			this.stopTyping(tenantId);
			return;
		}
		if (this.closed || !this.started || this.typingByTenant.has(tenantId) || !this.tenantUsers.has(tenantId)) return;
		const state: TypingState = { inFlight: false };
		this.typingByTenant.set(tenantId, state);
		state.timer = setInterval(() => void this.sendTyping(tenantId, state), this.typingRefreshMs);
		void this.sendTyping(tenantId, state);
	}

	private clearReadyTimer(): void {
		if (this.readyTimer) clearTimeout(this.readyTimer);
		this.readyTimer = undefined;
	}

	private clearReadyListener(): void {
		if (this.readyListener) this.client.off(Events.ClientReady, this.readyListener);
		this.readyListener = undefined;
	}

	private report(error: unknown): void {
		try {
			this.options.onError?.(asError(error));
		} catch {
			// Reporting must not break Discord event processing.
		}
	}

	private readonly onClientError = (...args: unknown[]): void => this.report(args[0]);

	private stopTyping(tenantId: string): void {
		const state = this.typingByTenant.get(tenantId);
		if (!state) return;
		if (state.timer) clearInterval(state.timer);
		this.typingByTenant.delete(tenantId);
	}

	private async sendTyping(tenantId: string, state: TypingState): Promise<void> {
		if (this.closed || this.typingByTenant.get(tenantId) !== state || state.inFlight) return;
		const userId = this.tenantUsers.get(tenantId);
		if (!userId) return;
		state.inFlight = true;
		try {
			const user = await this.client.users.fetch(userId);
			if (this.closed || this.typingByTenant.get(tenantId) !== state) return;
			const dm = await user.createDM();
			if (this.closed || this.typingByTenant.get(tenantId) !== state) return;
			await dm.sendTyping();
		} catch (error) {
			this.report(error);
		} finally {
			state.inFlight = false;
		}
	}

	private readonly onMessage = (message: IncomingMessage): void => {
		// Check channel type and author before reading or forwarding message content.
		if (message.channel.type !== ChannelType.DM || message.author.bot) return;
		const tenantId = this.userTenants.get(message.author.id);
		if (!tenantId) return;

		const input: ChannelInput = {
			tenantId,
			text: message.content,
			source: { kind: "discord", userId: message.author.id, channelId: message.channel.id },
			messageId: message.id,
		};
		Promise.resolve().then(() => this.options.onMessage(input)).catch((error: unknown) => this.report(error));
	};
}
