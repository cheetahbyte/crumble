import { ChannelType, Client, Events, GatewayIntentBits, Partials } from "discord.js";
import type { ChannelInput, ChannelMessageHandler } from "./types.ts";

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

export type DiscordChannel = {
	start(): Promise<void>;
	close(): Promise<void>;
	send(tenantId: string, text: string): Promise<void>;
	setTyping(tenantId: string, active: boolean): void;
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

export function createDiscordChannel(options: DiscordChannelOptions): DiscordChannel {
	const userTenants = new Map<string, string>();
	const tenantUsers = new Map<string, string>();
	for (const [tenantId, userId] of Object.entries(options.tenantUsers)) {
	if (!tenantId || !userId) throw new Error("Discord tenant and user IDs must be non-empty");
		if (userTenants.has(userId)) throw new Error("A Discord user can only be assigned to one tenant");
		userTenants.set(userId, tenantId);
		tenantUsers.set(tenantId, userId);
	}
	const readyTimeoutMs = options.readyTimeoutMs ?? 30_000;
	if (!Number.isSafeInteger(readyTimeoutMs) || readyTimeoutMs < 1 || readyTimeoutMs > 2_147_483_647) {
		throw new Error("Discord readyTimeoutMs must be a positive integer no greater than 2147483647");
	}
	const typingRefreshMs = options.typingRefreshMs ?? 8_000;
	if (!Number.isSafeInteger(typingRefreshMs) || typingRefreshMs < 1 || typingRefreshMs > 2_147_483_647) {
		throw new Error("Discord typingRefreshMs must be a positive integer no greater than 2147483647");
	}

	const client = options.createClient?.() ?? (new Client({
		intents: [GatewayIntentBits.DirectMessages],
		partials: [Partials.Channel],
		allowedMentions: { parse: [] },
	}) as unknown as DiscordClient);
	let started = false;
	let closed = false;
	let starting: Promise<void> | undefined;
	let rejectStarting: ((error: Error) => void) | undefined;
	let readyListener: ((...args: unknown[]) => void) | undefined;
	let readyTimer: ReturnType<typeof setTimeout> | undefined;
	type TypingState = { timer?: ReturnType<typeof setInterval>; inFlight: boolean };
	const typingByTenant = new Map<string, TypingState>();

	const clearReadyTimer = () => {
		if (readyTimer) clearTimeout(readyTimer);
		readyTimer = undefined;
	};
	const clearReadyListener = () => {
		if (readyListener) client.off(Events.ClientReady, readyListener);
		readyListener = undefined;
	};

	const report = (error: unknown) => {
		try {
			options.onError?.(asError(error));
		} catch {
			// Reporting must not break Discord event processing.
		}
	};

	const onClientError = (...args: unknown[]) => report(args[0]);
	const stopTyping = (tenantId: string) => {
		const state = typingByTenant.get(tenantId);
		if (!state) return;
		if (state.timer) clearInterval(state.timer);
		typingByTenant.delete(tenantId);
	};
	const sendTyping = async (tenantId: string, state: TypingState) => {
		if (closed || typingByTenant.get(tenantId) !== state || state.inFlight) return;
		const userId = tenantUsers.get(tenantId);
		if (!userId) return;
		state.inFlight = true;
		try {
			const user = await client.users.fetch(userId);
			if (closed || typingByTenant.get(tenantId) !== state) return;
			const dm = await user.createDM();
			if (closed || typingByTenant.get(tenantId) !== state) return;
			await dm.sendTyping();
		} catch (error) {
			report(error);
		} finally {
			state.inFlight = false;
		}
	};
	const onMessage = (message: IncomingMessage) => {
		// Check channel type and author before reading or forwarding message content.
		if (message.channel.type !== ChannelType.DM || message.author.bot) return;
		const tenantId = userTenants.get(message.author.id);
		if (!tenantId) return;

		const input: ChannelInput = {
			tenantId,
			text: message.content,
			source: { kind: "discord", userId: message.author.id, channelId: message.channel.id },
			messageId: message.id,
		};
		Promise.resolve().then(() => options.onMessage(input)).catch(report);
	};

	client.on("messageCreate", onMessage);
	client.on("error", onClientError);

	return {
		start() {
			if (closed) return Promise.reject(new Error("Discord channel is closed"));
			if (started) return Promise.resolve();
			if (starting) return starting;

			starting = new Promise<void>((resolve, reject) => {
				const fail = (error: Error) => {
					if (!rejectStarting) return;
					const rejectStart = rejectStarting;
					clearReadyTimer();
					clearReadyListener();
					for (const tenantId of typingByTenant.keys()) stopTyping(tenantId);
					rejectStarting = undefined;
					client.off("messageCreate", onMessage);
					client.off("error", onClientError);
					closed = true;
					client.destroy();
					rejectStart(error);
				};
				const ready = () => {
					clearReadyTimer();
					clearReadyListener();
					rejectStarting = undefined;
					started = true;
					resolve();
				};
				readyListener = ready;
				rejectStarting = reject;
				client.on(Events.ClientReady, ready);
				readyTimer = setTimeout(
					() => fail(new Error(`Discord client did not become ready within ${readyTimeoutMs}ms`)),
					readyTimeoutMs,
				);
				void client.login(options.token).catch((error: unknown) => fail(asError(error)));
			}).finally(() => {
				starting = undefined;
			});
			return starting;
		},
		async close() {
			if (closed) return;
			closed = true;
			for (const tenantId of typingByTenant.keys()) stopTyping(tenantId);
			client.off("messageCreate", onMessage);
			client.off("error", onClientError);
			clearReadyTimer();
			clearReadyListener();
			rejectStarting?.(new Error("Discord channel closed before becoming ready"));
			readyListener = undefined;
			rejectStarting = undefined;
			client.destroy();
		},
		async send(tenantId, text) {
			if (!started || closed) throw new Error("Discord channel is not running");
			const userId = tenantUsers.get(tenantId);
			if (!userId) throw new Error(`No Discord user is configured for tenant ${tenantId}`);
			const chunks = splitMessage(text);
			if (chunks.length === 0) return;
			const user = await client.users.fetch(userId);
			const dm = await user.createDM();
			for (const content of chunks) {
				await dm.send({ content, allowedMentions: { parse: [] } });
			}
		},
		setTyping(tenantId, active) {
			if (!active) {
				stopTyping(tenantId);
				return;
			}
			if (closed || !started || typingByTenant.has(tenantId) || !tenantUsers.has(tenantId)) return;
			const state: TypingState = { inFlight: false };
			typingByTenant.set(tenantId, state);
			state.timer = setInterval(() => void sendTyping(tenantId, state), typingRefreshMs);
			void sendTyping(tenantId, state);
		},
	};
}
