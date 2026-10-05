import { join } from "node:path";
import { BrowserManager } from "./browser.ts";
import { LearningStore } from "./learning.ts";
import { TenantAssistant } from "./assistant.ts";
import { createRunner } from "./config.ts";
import { describeJob } from "./extensions/delegate.ts";
import { InboxProcessor } from "./inbox.ts";
import { JobStore } from "./jobs.ts";
import { PluginManager } from "./plugins.ts";
import type { ParentMessage, TenantMessage } from "./protocol.ts";
import { AssistantState } from "./state.ts";
import { Supervisor } from "./supervisor.ts";

let state: AssistantState | undefined;
let jobs: JobStore | undefined;
let learning: LearningStore | undefined;
let assistant: TenantAssistant | undefined;
let inbox: InboxProcessor | undefined;
let supervisor: Supervisor | undefined;
let timer: NodeJS.Timeout | undefined;
let stopping = false;

function send(message: TenantMessage): void {
	if (process.connected) process.send?.(message, () => {});
}

function collectJobNotifications(): void {
	if (!jobs || !state || stopping) return;
	for (const notification of jobs.pendingNotifications()) {
		state.enqueue({
			id: `job:${notification.job.id}:${notification.version}`, source: "internal",
			text: `Worker supervisor event (not a new request from the person; long results may be truncated here):\n${describeJob(notification.job).slice(0, 28_000)}\n` +
				"Report the outcome or ask the person the pending question. Use message_job for follow-ups. Interrupted, failed, or cancelled work needs an explicit retry request.",
		});
		jobs.acknowledgeNotification(notification.job.id, notification.version);
	}
}

function wake(): void {
	if (stopping) return;
	try { collectJobNotifications(); }
	catch { send({ type: "error", message: "Could not queue a saved worker update; it remains pending for retry." }); }
	void inbox?.wake();
}

async function shutdown(): Promise<void> {
	if (stopping) return;
	stopping = true;
	if (timer) clearInterval(timer);
	await assistant?.close();
	await inbox?.close();
	await supervisor?.close();
	learning?.close();
	jobs?.close();
	state?.close();
	process.disconnect?.();
	// Pi's process-wide services can retain handles after a session is disposed.
	// All durable work and child workers have been closed above.
	process.exit(0);
}

process.on("message", (message: ParentMessage) => {
	if (message.type === "wake") { wake(); return; }
	if (message.type === "interrupt") { void assistant?.abort().catch(() => {}); return; }
	if (message.type === "stop") { void shutdown(); return; }
	if (message.type !== "init" || state) return;
	try {
		const { tenant, app, pluginsDisabled } = message;
		state = new AssistantState(tenant.stateDatabasePath);
		state.recoverInterrupted();
		jobs = new JobStore(tenant.jobsDatabasePath);
		supervisor = new Supervisor({
			store: jobs, runner: createRunner(tenant, app), askExtension: app.askExtension,
			provider: tenant.provider, model: tenant.model, onSettled: () => wake(),
		});
		supervisor.recoverInterrupted();
		learning = new LearningStore(tenant.stateDatabasePath);
		assistant = new TenantAssistant({
			tenant, state, jobs, supervisor, learning,
			browser: new BrowserManager({ tenantId: tenant.id, rootDir: tenant.rootDir }),
			plugins: new PluginManager({
				rootDir: join(tenant.rootDir, "plugins"), workspacesDir: tenant.workspacesDir,
				tenantId: tenant.id, image: app.sandboxImage, disabled: pluginsDisabled,
			}),
		});
		inbox = new InboxProcessor({
			state, handle: (request) => assistant!.handle(request),
			activity: (request, active) => {
				const quiet = request.scheduleId && state!.getSchedule(request.scheduleId)?.notificationPolicy === "changes_only";
				send({ type: "activity", active: active && !quiet, source: request.source });
			},
			changed: () => send({ type: "changed" }),
			onError: () => send({ type: "error", message: "Assistant queue failed; requests remain stored for recovery." }),
		});
		timer = setInterval(wake, 1_000);
		send({ type: "ready" });
		wake();
	} catch (error) {
		send({ type: "error", message: error instanceof Error ? error.message : "Tenant startup failed." });
		void shutdown();
	}
});

process.on("disconnect", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
process.on("SIGINT", () => { void shutdown(); });
