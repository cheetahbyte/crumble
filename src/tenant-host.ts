import { fork, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { DiscordChannel } from "./channels/discord.ts";
import type { RuntimeConfig } from "./config.ts";
import { openDatabase } from "./db/database.ts";
import { isStopRequest, type ParentMessage, type TenantMessage } from "./protocol.ts";
import { AssistantState, type InboundSource } from "./state.ts";
import { tenantEnvironment, type TenantConfig } from "./tenants.ts";

export interface TenantHostOptions {
	config: TenantConfig;
	runtime: RuntimeConfig;
	pluginsDisabled: boolean;
	discord?: DiscordChannel;
}

/** Runs one tenant's assistant process, restarts it on exit, and delivers its saved replies. */
export class TenantHost {
	readonly config: TenantConfig;
	private readonly options: TenantHostOptions;
	private readonly db: DatabaseSync;
	private readonly state: AssistantState;
	private child?: ChildProcess;
	private restartTimer?: NodeJS.Timeout;
	private restarts = 0;
	private delivering?: Promise<void>;
	private retryDeliveryAt = 0;
	private deliveryFailures = 0;
	private stopping = false;

	constructor(options: TenantHostOptions) {
		this.options = options;
		this.config = options.config;
		this.db = openDatabase(options.config.stateDatabasePath, "assistant");
		this.state = new AssistantState(this.db);
	}

	start(): void {
		if (this.stopping) return;
		const { config, discord } = this.options;
		const child = fork(join(import.meta.dirname, "tenant-process.ts"), [], {
			cwd: config.homeDir, env: tenantEnvironment(config),
			// Do not inherit Node --env-file flags that could reload the bot's secrets.
			execArgv: [],
			stdio: ["ignore", "ignore", "pipe", "ipc"],
		});
		this.child = child;
		const startedAt = Date.now();
		child.stderr?.on("data", (data: Buffer) => process.stderr.write(`[${config.id}] ${data.toString().slice(0, 2_000)}`));
		child.on("message", (message: TenantMessage) => {
			if (this.child !== child || this.stopping) return;
			if (message.type === "activity") {
				discord?.setTyping(config.id, message.active && message.source !== "terminal");
			} else if (message.type === "ready") {
				this.signal({ type: "wake" });
				void this.deliver();
			} else if (message.type === "changed") void this.deliver();
			else if (message.type === "error") console.error(`[${config.id}] ${message.message}`);
		});
		child.on("error", (error) => console.error(`[${config.id}] Could not run assistant: ${error.message}`));
		child.on("exit", () => {
			if (this.child === child) {
				this.child = undefined;
				discord?.setTyping(config.id, false);
			}
			if (this.stopping) return;
			this.restarts = Date.now() - startedAt > 60_000 ? 0 : this.restarts + 1;
			const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.restarts, 5));
			console.error(`[${config.id}] Assistant stopped; restarting in ${delay / 1_000}s. Pending requests are saved.`);
			this.restartTimer = setTimeout(() => this.start(), delay);
		});
		this.signal({ type: "init", tenant: config, pluginsDisabled: this.options.pluginsDisabled, app: this.options.runtime });
	}

	enqueue(id: string, text: string, source: InboundSource): void {
		if (this.stopping || !text.trim()) return;
		const inserted = this.state.enqueue({ id, text, source });
		if (inserted && (isStopRequest(text) || /^\/plugin(?:\s|$)/.test(text.trim()))) this.signal({ type: "interrupt" });
		this.signal({ type: "wake" });
	}

	/** Periodic work: queue due schedules, wake the assistant, and retry deliveries. */
	tick(): void {
		try { this.state.enqueueDueSchedules(); }
		catch { console.error(`[${this.config.id}] Schedule processing failed; schedules remain saved.`); }
		this.signal({ type: "wake" });
		void this.deliver();
	}

	async stop(): Promise<void> {
		this.stopping = true;
		if (this.restartTimer) clearTimeout(this.restartTimer);
		const child = this.child;
		if (child && child.exitCode === null && child.signalCode === null) {
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
				child.once("exit", () => { clearTimeout(timer); resolve(); });
				this.signal({ type: "stop" });
			});
		}
		await this.delivering;
		this.db.close();
	}

	private signal(message: ParentMessage): void {
		if (this.child?.connected) this.child.send(message, () => {});
	}

	private deliver(): Promise<void> {
		if (this.delivering) return this.delivering;
		if (this.stopping || Date.now() < this.retryDeliveryAt) return Promise.resolve();
		const { config, discord } = this.options;
		this.delivering = (async () => {
			for (const delivery of this.state.pendingDeliveries()) {
				if (this.stopping) break;
				const useDiscord = delivery.source === "discord" || (delivery.source === "internal" && !!config.discordUserId && !!discord);
				if (!useDiscord || !discord) continue;
				await discord.send(config.id, delivery.response);
				this.state.acknowledgeDelivery(delivery.id);
			}
			this.deliveryFailures = 0;
		})().catch(() => {
			this.deliveryFailures += 1;
			this.retryDeliveryAt = Date.now() + Math.min(60_000, 2_000 * 2 ** Math.min(this.deliveryFailures, 5));
			console.error(`[${config.id}] Reply delivery failed; the saved reply will be retried.`);
		}).finally(() => { this.delivering = undefined; });
		return this.delivering;
	}
}
