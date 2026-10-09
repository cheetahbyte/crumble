import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DiscordChannel } from "#channels";
import { loadAppConfig } from "#config";
import { TenantHost } from "#host";
import { prepareTenant } from "#tenants";

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

const hosts = new Map<string, TenantHost>();
let discord: DiscordChannel | undefined;
let stopping = false;
let interval: NodeJS.Timeout | undefined;

async function stop(): Promise<void> {
	if (stopping) return;
	stopping = true;
	if (interval) clearInterval(interval);
	const stopped = [...hosts.values()].map((host) => host.stop());
	await discord?.close();
	await Promise.all(stopped);
	try { unlinkSync(lockPath); } catch { /* Already released. */ }
}

process.on("SIGINT", () => { void stop(); });
process.on("SIGTERM", () => { void stop(); });

try {
	for (const config of app.tenants) prepareTenant(config);
	if (discordToken && Object.keys(discordUsers).length) {
		discord = new DiscordChannel({
			token: discordToken, tenantUsers: discordUsers,
			onMessage: (message) => hosts.get(message.tenantId)?.enqueue(`discord:${message.messageId}`, message.text, "discord"),
			onError: () => console.error("Discord connection or incoming-message handling failed; see channel availability."),
		});
	}
	const runtime = { runnerKind: app.runnerKind, sandboxImage: app.sandboxImage };
	for (const config of app.tenants) hosts.set(config.id, new TenantHost({ config, runtime, pluginsDisabled, channel: discord }));
	if (discord) {
		await discord.start();
		console.log("Discord private messages connected.");
	}
	for (const host of hosts.values()) host.start();
	interval = setInterval(() => { for (const host of hosts.values()) host.tick(); }, 1_000);
	console.log(`Crumble service ready for ${hosts.size} tenant${hosts.size === 1 ? "" : "s"}. Plugins ${pluginsDisabled ? "disabled (safe mode)" : "available"}.`);
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	await stop();
	process.exitCode = 1;
}
