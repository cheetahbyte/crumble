export type ChannelInput = {
	tenantId: string;
	text: string;
	source: { kind: "discord"; userId: string; channelId: string };
	messageId: string;
};

export type ChannelMessageHandler = (message: ChannelInput) => void | Promise<void>;
