import assert from "node:assert/strict";
import { test } from "node:test";
import { Events } from "discord.js";
import { DiscordChannel } from "../../src/channels/discord.ts";

type Listener = (...args: never[]) => void;

function fakeClient(sendFailureAt?: number, behavior: { emitReady?: boolean; loginError?: Error; typingError?: Error } = {}) {
	const listeners = new Map<string, Set<Listener>>();
	const sent: Array<{ userId: string; content: string; allowedMentions: { parse: [] } }> = [];
	const fetched: string[] = [];
	const typing: string[] = [];
	let sendCount = 0;
	let destroyed = false;
	const client = {
		on(event: string, listener: Listener) {
			const bucket = listeners.get(event) ?? new Set<Listener>();
			bucket.add(listener);
			listeners.set(event, bucket);
			return this;
		},
		off(event: string, listener: Listener) {
			listeners.get(event)?.delete(listener);
			return this;
		},
		emit(event: string, ...args: never[]) {
			for (const listener of listeners.get(event) ?? []) listener(...args);
		},
		async login() {
			if (behavior.loginError) throw behavior.loginError;
			if (behavior.emitReady !== false) queueMicrotask(() => this.emit(Events.ClientReady));
			return "logged-in";
		},
		destroy() {
			destroyed = true;
		},
		users: {
			async fetch(userId: string) {
				fetched.push(userId);
				return {
					async createDM() {
						return {
							async send(options: { content: string; allowedMentions: { parse: [] } }) {
								sendCount += 1;
								if (sendFailureAt === sendCount) throw new Error("delivery failed");
								sent.push({ userId, ...options });
							},
							async sendTyping() {
								typing.push(userId);
								if (behavior.typingError) throw behavior.typingError;
							},
						};
					},
				};
			},
		},
	};
	return { client, sent, fetched, typing, get destroyed() { return destroyed; } };
}

const make = (createClient: () => ReturnType<typeof fakeClient>["client"], rest: Record<string, unknown> = {}) =>
	new DiscordChannel({
		token: "test-token",
		tenantUsers: { alice: "user-a", bob: "user-b" },
		onMessage: () => {},
		createClient: createClient as never,
		...rest,
	});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

test("routes only allowlisted private user DMs and ignores bots, guilds, and unknown users", async () => {
	const fake = fakeClient();
	const received: unknown[] = [];
	const channel = make(() => fake.client, { onMessage: (message: unknown) => received.push(message) });
	await channel.start();
	const emit = (authorId: string, type: number, bot = false) => fake.client.emit("messageCreate", {
		author: { id: authorId, bot },
		channel: { id: "dm-1", type },
		content: "hello",
		id: "message-1",
	} as never);

	emit("user-a", 1);
	emit("unknown", 1);
	emit("user-a", 1, true);
	emit("user-a", 0); // guild text channel
	await new Promise((resolve) => setImmediate(resolve));

	assert.deepEqual(received, [{
		tenantId: "alice",
		text: "hello",
		source: { kind: "discord", userId: "user-a", channelId: "dm-1" },
		messageId: "message-1",
	}]);
	await channel.close();
});

test("sends only to the tenant's configured DM and disables mentions", async () => {
	const fake = fakeClient();
	const channel = make(() => fake.client);
	await channel.start();
	await channel.send("bob", "hello @everyone <@123>");
	assert.deepEqual(fake.fetched, ["user-b"]);
	assert.deepEqual(fake.sent, [{ userId: "user-b", content: "hello @everyone <@123>", allowedMentions: { parse: [] } }]);
	await assert.rejects(channel.send("missing", "no route"), /No Discord user is configured/);
	await channel.close();
});

test("chunks output to Discord's limit without splitting Unicode code points", async () => {
	const fake = fakeClient();
	const channel = make(() => fake.client);
	await channel.start();
	const text = `${"a".repeat(1999)}😀${"b".repeat(2001)}`;
	await channel.send("alice", text);
	assert.deepEqual(fake.sent.map((item) => item.content.length), [1999, 2000, 3]);
	assert.equal(fake.sent.map((item) => item.content).join(""), text);
	assert.ok(fake.sent.every((item) => item.content.length <= 2000));
	await channel.close();
});

test("delivery errors reject instead of reporting a successful send", async () => {
	const fake = fakeClient(2);
	const channel = make(() => fake.client);
	await channel.start();
	await assert.rejects(channel.send("alice", "x".repeat(2001)), /delivery failed/);
	assert.equal(fake.sent.length, 1);
	await channel.close();
});

test("reports inbound handler failures without logging message content", async () => {
	const fake = fakeClient();
	const errors: Error[] = [];
	const channel = make(() => fake.client, {
		onMessage: async () => { throw new Error("handler failed"); },
		onError: (error: Error) => errors.push(error),
	});
	await channel.start();
	fake.client.emit("messageCreate", {
		author: { id: "user-a", bot: false },
		channel: { id: "dm-1", type: 1 },
		content: "private text",
		id: "message-1",
	} as never);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(errors.map((error) => error.message), ["handler failed"]);
	await channel.close();
});

test("waits for ready and destroys the client when closed", async () => {
	const fake = fakeClient();
	const channel = make(() => fake.client);
	await channel.start();
	assert.equal(fake.destroyed, false);
	await channel.close();
	assert.equal(fake.destroyed, true);
	await assert.rejects(channel.start(), /closed/);
});

test("fails and destroys the client when it never becomes ready", async () => {
	const fake = fakeClient(undefined, { emitReady: false });
	const channel = make(() => fake.client, { readyTimeoutMs: 5 });
	await assert.rejects(channel.start(), /did not become ready within 5ms/);
	assert.equal(fake.destroyed, true);
	await assert.rejects(channel.send("alice", "too early"), /not running/);
	await channel.close();
});

test("clears the readiness timer when login fails", async () => {
	const fake = fakeClient(undefined, { loginError: new Error("login failed") });
	const channel = make(() => fake.client, { readyTimeoutMs: 5_000 });
	await assert.rejects(channel.start(), /login failed/);
	assert.equal(fake.destroyed, true);
});

test("clears the readiness timer when closed during startup", async () => {
	const fake = fakeClient(undefined, { emitReady: false });
	const channel = make(() => fake.client, { readyTimeoutMs: 5_000 });
	const starting = channel.start();
	await channel.close();
	await assert.rejects(starting, /closed before becoming ready/);
	assert.equal(fake.destroyed, true);
});

test("starts typing immediately, refreshes once per tenant, and stops idempotently", async () => {
	const fake = fakeClient();
	const channel = make(() => fake.client, { typingRefreshMs: 5 });
	await channel.start();
	channel.setTyping("alice", true);
	channel.setTyping("alice", true);
	channel.setTyping("missing", true);
	await wait(18);
	assert.ok(fake.typing.length >= 2);
	assert.ok(fake.typing.every((userId) => userId === "user-a"));
	channel.setTyping("alice", false);
	channel.setTyping("alice", false);
	const stoppedCount = fake.typing.length;
	await wait(18);
	assert.equal(fake.typing.length, stoppedCount);
	await channel.close();
});

test("does not send typing after an in-flight user fetch completes following stop", async () => {
	const fake = fakeClient();
	const fetched = deferred<void>();
	fake.client.users.fetch = async (userId: string) => {
		fake.fetched.push(userId);
		await fetched.promise;
		return { createDM: async () => ({ send: async () => {}, sendTyping: async () => { fake.typing.push(userId); } }) };
	};
	const channel = make(() => fake.client);
	await channel.start();
	channel.setTyping("alice", true);
	channel.setTyping("alice", false);
	fetched.resolve();
	await wait(0);
	assert.deepEqual(fake.typing, []);
	await channel.close();
});

test("does not send typing after createDM completes following close", async () => {
	const fake = fakeClient();
	const created = deferred<void>();
	fake.client.users.fetch = async (userId: string) => ({
		createDM: async () => {
			await created.promise;
			return { send: async () => {}, sendTyping: async () => { fake.typing.push(userId); } };
		},
	});
	const channel = make(() => fake.client);
	await channel.start();
	channel.setTyping("bob", true);
	await channel.close();
	created.resolve();
	await wait(0);
	assert.deepEqual(fake.typing, []);
});

test("typing failures are reported and do not affect normal replies", async () => {
	const fake = fakeClient(undefined, { typingError: new Error("typing failed") });
	const errors: Error[] = [];
	const channel = make(() => fake.client, { onError: (error: Error) => errors.push(error) });
	await channel.start();
	channel.setTyping("alice", true);
	await wait(0);
	await channel.send("alice", "reply still works");
	assert.deepEqual(errors.map((error) => error.message), ["typing failed"]);
	assert.equal(fake.sent[0]?.content, "reply still works");
	await channel.close();
});

test("close clears all tenant typing refreshes", async () => {
	const fake = fakeClient();
	const channel = make(() => fake.client, { typingRefreshMs: 5 });
	await channel.start();
	channel.setTyping("alice", true);
	channel.setTyping("bob", true);
	await wait(0);
	await channel.close();
	const stoppedCount = fake.typing.length;
	await wait(18);
	assert.equal(fake.typing.length, stoppedCount);
});
