import { fork, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createDiscordChannel, type DiscordChannel } from "./channels/discord.ts";
import { loadAppConfig } from "./config.ts";
import { isStopRequest, type ParentMessage, type TenantMessage } from "./protocol.ts";
import { AssistantState, type InboundSource } from "./state.ts";
import { prepareTenant, tenantEnvironment, type TenantConfig } from "./tenants.ts";

const app = loadAppConfig();
const pluginsDisabled = process.env.CRUMBLE_DISABLE_PLUGINS === "1";
const discordToken = process.env.DISCORD_TOKEN;
const discordUsers = Object.fromEntries(app.tenants.filter((t) => t.discordUserId).map((t) => [t.id, t.discordUserId!]));

mkdirSync(app.dataDir, { recursive: true, mode: 0o700 });
const lockPath = join(app.dataDir, "service.lock");
function acquireLock(): void {
	try { writeFileSync(lockPath, String(process.pid), { flag: "wx", mode: 0o600 }); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const pid = Number(readFileSync(lockPath, "utf8"));
		if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid process lock at ${lockPath}; inspect it before removing it.`);
		try { process.kill(pid, 0); }
		catch (probe) {
			if ((probe as NodeJS.ErrnoException).code !== "ESRCH") throw probe;
			unlinkSync(lockPath);
			writeFileSync(lockPath, String(process.pid), { flag: "wx", mode: 0o600 });
			return;
		}
		throw new Error(`Crumble is already running for this data directory (PID ${pid}).`);
	}
}
acquireLock();

interface LiveTenant {
	config: TenantConfig;
	state: AssistantState;
	child?: ChildProcess;
	restartTimer?: NodeJS.Timeout;
	restarts: number;
	delivering?: Promise<void>;
	retryDeliveryAt: number;
	deliveryFailures: number;
}

const tenants = new Map<string, LiveTenant>();
let discord: DiscordChannel | undefined;
let stopping = false;
let interval: NodeJS.Timeout | undefined;

function signal(tenant: LiveTenant, message: ParentMessage): void {
	if (tenant.child?.connected) tenant.child.send(message, () => {});
}

function startTenant(tenant: LiveTenant): void {
	if (stopping) return;
	const child = fork(join(import.meta.dirname, "tenant-process.ts"), [], {
		cwd: tenant.config.homeDir, env: tenantEnvironment(tenant.config),
		// Do not inherit Node --env-file flags that could reload the bot's secrets.
		execArgv: [],
		stdio: ["ignore", "ignore", "pipe", "ipc"],
	});
	tenant.child = child;
	const startedAt = Date.now();
	child.stderr?.on("data", (data: Buffer) => process.stderr.write(`[${tenant.config.id}] ${data.toString().slice(0, 2_000)}`));
	child.on("message", (message: TenantMessage) => {
		if (tenant.child !== child || stopping) return;
		if (message.type === "activity") {
			discord?.setTyping(tenant.config.id, message.active && message.source !== "terminal");
		} else if (message.type === "ready") {
			signal(tenant, { type: "wake" });
			void deliver(tenant);
		} else if (message.type === "changed") void deliver(tenant);
		else if (message.type === "error") console.error(`[${tenant.config.id}] ${message.message}`);
	});
	child.on("error", (error) => console.error(`[${tenant.config.id}] Could not run assistant: ${error.message}`));
	child.on("exit", () => {
		if (tenant.child === child) {
			tenant.child = undefined;
			discord?.setTyping(tenant.config.id, false);
		}
		if (stopping) return;
		tenant.restarts = Date.now() - startedAt > 60_000 ? 0 : tenant.restarts + 1;
		const delay = Math.min(30_000, 1_000 * 2 ** Math.min(tenant.restarts, 5));
		console.error(`[${tenant.config.id}] Assistant stopped; restarting in ${delay / 1_000}s. Pending requests are saved.`);
		tenant.restartTimer = setTimeout(() => startTenant(tenant), delay);
	});
	signal(tenant, {
		type: "init", tenant: tenant.config, pluginsDisabled,
		app: { runnerKind: app.runnerKind, sandboxImage: app.sandboxImage, askExtension: app.askExtension },
	});
}

function enqueue(tenantId: string, id: string, text: string, source: InboundSource): void {
	const tenant = tenants.get(tenantId);
	if (!tenant || stopping) return;
	if (!text.trim()) return;
	const inserted = tenant.state.enqueue({ id, text, source });
	if (inserted && (isStopRequest(text) || /^\/plugin(?:\s|$)/.test(text.trim()))) signal(tenant, { type: "interrupt" });
	signal(tenant, { type: "wake" });
}

function deliver(tenant: LiveTenant): Promise<void> {
	if (tenant.delivering) return tenant.delivering;
	if (stopping || Date.now() < tenant.retryDeliveryAt) return Promise.resolve();
	tenant.delivering = (async () => {
		for (const delivery of tenant.state.pendingDeliveries()) {
			if (stopping) break;
			const useDiscord = delivery.source === "discord" || (delivery.source === "internal" && !!tenant.config.discordUserId && !!discord);
			if (!useDiscord || !discord) continue;
			await discord.send(tenant.config.id, delivery.response);
			tenant.state.acknowledgeDelivery(delivery.id);
		}
		tenant.deliveryFailures = 0;
	})().catch(() => {
		tenant.deliveryFailures += 1;
		tenant.retryDeliveryAt = Date.now() + Math.min(60_000, 2_000 * 2 ** Math.min(tenant.deliveryFailures, 5));
		console.error(`[${tenant.config.id}] Reply delivery failed; the saved reply will be retried.`);
	}).finally(() => { tenant.delivering = undefined; });
	return tenant.delivering;
}

async function stop(): Promise<void> {
	if (stopping) return;
	stopping = true;
	if (interval) clearInterval(interval);
	await discord?.close();
	await Promise.all([...tenants.values()].map(async (tenant) => {
		if (tenant.restartTimer) clearTimeout(tenant.restartTimer);
		const child = tenant.child;
		if (child && child.exitCode === null && child.signalCode === null) {
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
				child.once("exit", () => { clearTimeout(timer); resolve(); });
				signal(tenant, { type: "stop" });
			});
		}
		await tenant.delivering;
		tenant.state.close();
	}));
	try { unlinkSync(lockPath); } catch { /* Already released. */ }
}

process.on("SIGINT", () => { void stop(); });
process.on("SIGTERM", () => { void stop(); });

try {
	for (const config of app.tenants) {
		prepareTenant(config);
		tenants.set(config.id, { config, state: new AssistantState(config.stateDatabasePath), restarts: 0, retryDeliveryAt: 0, deliveryFailures: 0 });
	}
	if (discordToken && Object.keys(discordUsers).length) {
		discord = createDiscordChannel({
			token: discordToken, tenantUsers: discordUsers,
			onMessage: (message) => enqueue(message.tenantId, `discord:${message.messageId}`, message.text, "discord"),
			onError: () => console.error("Discord connection or incoming-message handling failed; see channel availability."),
		});
		await discord.start();
		console.log("Discord private messages connected.");
	}
	for (const tenant of tenants.values()) startTenant(tenant);
	interval = setInterval(() => {
		for (const tenant of tenants.values()) {
			try { tenant.state.enqueueDueSchedules(); }
			catch { console.error(`[${tenant.config.id}] Schedule processing failed; schedules remain saved.`); }
			signal(tenant, { type: "wake" });
			void deliver(tenant);
		}
	}, 1_000);
	console.log(`Crumble service ready for ${tenants.size} tenant${tenants.size === 1 ? "" : "s"}. Plugins ${pluginsDisabled ? "disabled (safe mode)" : "available"}.`);
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	await stop();
	process.exitCode = 1;
}
