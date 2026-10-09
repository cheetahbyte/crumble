export { DiscordChannel, type DiscordChannelOptions } from "./discord.ts";

export type ChannelInput = {
	tenantId: string;
	text: string;
	source: { kind: "discord"; userId: string; channelId: string };
	messageId: string;
};

export type ChannelMessageHandler = (message: ChannelInput) => void | Promise<void>;

/** A messaging surface that carries tenant requests in and saved replies out. */
export interface Channel {
	/** Matches the inbox source of requests that arrived through this channel. */
	readonly kind: ChannelInput["source"]["kind"];
	start(): Promise<void>;
	close(): Promise<void>;
	serves(tenantId: string): boolean;
	send(tenantId: string, text: string): Promise<void>;
	setTyping(tenantId: string, active: boolean): void;
}
