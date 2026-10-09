import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { InferSelectModel } from "drizzle-orm";
import { CronExpressionParser } from "cron-parser";
import { transaction } from "#db/database";
import type { assistantSchedules } from "#db/assistant-schema";
import { type Inbox, type InboundSource, validateId, validateSource, validateText } from "#inbox";
import { validateTimezone } from "#shared/paths";

export interface ScheduleInput {
	id?: string;
	label: string;
	prompt: string;
	dueAt?: string | number;
	intervalMs?: number;
	cron?: string;
	timezone?: string;
	notificationPolicy?: "always" | "changes_only";
	source: InboundSource;
}

export interface ScheduleUpdate {
	label?: string;
	prompt?: string;
	dueAt?: string | number;
	intervalMs?: number | null;
	cron?: string | null;
	timezone?: string;
	notificationPolicy?: "always" | "changes_only";
}

export interface Schedule {
	id: string;
	label: string;
	prompt: string;
	dueAt: number;
	intervalMs: number | null;
	source: InboundSource;
	enabled: boolean;
	createdAt: number;
	cron: string | null;
	timezone: string;
	notificationPolicy: "always" | "changes_only";
	lastResult: string | null;
	lastNotifiedResult: string | null;
	paused: boolean;
}

type ScheduleRow = InferSelectModel<typeof assistantSchedules>;

const MIN_INTERVAL_MS = 60_000;

function toSchedule(row: ScheduleRow): Schedule {
	validateSource(row.source);
	return {
		id: row.id,
		label: row.label,
		prompt: row.prompt,
		dueAt: row.due_at,
		intervalMs: row.interval_ms,
		source: row.source,
		enabled: row.enabled === 1,
		createdAt: row.created_at,
		cron: row.cron,
		timezone: row.timezone,
		notificationPolicy: row.notification_policy === "changes_only" ? "changes_only" : "always",
		lastResult: row.last_result,
		lastNotifiedResult: row.last_notified_result,
		paused: row.paused === 1,
	};
}

function timestamp(value: string | number): number {
	const result = typeof value === "number" ? value : Date.parse(value);
	if (!Number.isFinite(result)) throw new Error("Schedule dueAt must be a valid ISO date or finite millisecond timestamp");
	return Math.trunc(result);
}

function cronNext(cron: string, timezone: string, from: number): number {
	return CronExpressionParser.parse(cron, { currentDate: new Date(from), tz: timezone }).next().getTime();
}

function validateScheduleFields(input: Pick<ScheduleInput, "cron" | "timezone" | "notificationPolicy" | "intervalMs">): void {
	if (input.intervalMs !== undefined && (!Number.isSafeInteger(input.intervalMs) || input.intervalMs < MIN_INTERVAL_MS)) {
		throw new Error(`Schedule intervalMs must be an integer of at least ${MIN_INTERVAL_MS}`);
	}
	if (input.cron && input.intervalMs !== undefined) throw new Error("A schedule cannot use both cron and intervalMs");
	if (input.notificationPolicy !== undefined && input.notificationPolicy !== "always" && input.notificationPolicy !== "changes_only") {
		throw new Error("notificationPolicy must be always or changes_only");
	}
	if (input.timezone !== undefined) validateTimezone(input.timezone);
	if (input.cron !== undefined && input.cron !== null) {
		if (typeof input.cron !== "string" || input.cron.trim() === "") throw new Error("cron must be a non-empty expression");
		CronExpressionParser.parse(input.cron, { currentDate: new Date(), tz: input.timezone ?? "UTC" });
	}
}

/** Tenant-local scheduled prompts. Due runs go through the inbox; the caller owns the database connection. */
export class Routines {
	private readonly db: DatabaseSync;
	private readonly inbox: Inbox;

	constructor(db: DatabaseSync, inbox: Inbox) {
		this.db = db;
		this.inbox = inbox;
		inbox.useDeliveryPolicy((scheduleId, response, notify) => this.recordResult(scheduleId, response, notify));
	}

	createSchedule(input: ScheduleInput): Schedule {
		const id = input.id ?? randomUUID();
		validateId(id);
		validateText(input.label, "Schedule label", 256);
		validateText(input.prompt, "Schedule prompt");
		validateSource(input.source);
	const timezone = input.timezone ?? "UTC";
	validateScheduleFields(input);
	const dueAt = input.dueAt === undefined
		? (input.cron ? cronNext(input.cron, timezone, Date.now()) : (() => { throw new Error("Schedule dueAt is required unless cron is set"); })())
		: timestamp(input.dueAt);
		const intervalMs = input.intervalMs ?? null;
		const createdAt = Date.now();
		this.db.prepare(`INSERT INTO assistant_schedules (id, label, prompt, due_at, interval_ms, source, enabled, created_at, cron, timezone, notification_policy)
			VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`).run(id, input.label, input.prompt, dueAt, intervalMs, input.source, createdAt, input.cron ?? null, timezone, input.notificationPolicy ?? "always");
		return { id, label: input.label, prompt: input.prompt, dueAt, intervalMs, source: input.source, enabled: true, createdAt,
			cron: input.cron ?? null, timezone, notificationPolicy: input.notificationPolicy ?? "always", lastResult: null, lastNotifiedResult: null, paused: false };
	}

	listSchedules(): Schedule[] {
		const rows = this.db.prepare("SELECT * FROM assistant_schedules ORDER BY due_at, id").all() as unknown as ScheduleRow[];
		return rows.map(toSchedule);
	}

	getSchedule(id: string): Schedule | undefined {
		validateId(id);
		const row = this.db.prepare("SELECT * FROM assistant_schedules WHERE id = ?").get(id) as ScheduleRow | undefined;
		return row ? toSchedule(row) : undefined;
	}

	cancelSchedule(id: string): boolean {
		validateId(id);
		return Number(this.db.prepare("UPDATE assistant_schedules SET enabled = 0 WHERE id = ? AND enabled = 1").run(id).changes) > 0;
	}

	pauseSchedule(id: string): boolean {
		validateId(id);
		return Number(this.db.prepare("UPDATE assistant_schedules SET paused = 1 WHERE id = ? AND enabled = 1 AND paused = 0").run(id).changes) > 0;
	}

	resumeSchedule(id: string): boolean {
		validateId(id);
		return Number(this.db.prepare("UPDATE assistant_schedules SET paused = 0 WHERE id = ? AND enabled = 1 AND paused = 1").run(id).changes) > 0;
	}

	updateSchedule(id: string, update: ScheduleUpdate): Schedule | undefined {
		validateId(id);
		const current = this.db.prepare("SELECT * FROM assistant_schedules WHERE id = ? AND enabled = 1").get(id) as ScheduleRow | undefined;
		if (!current) return undefined;
		const nextCron = update.cron === undefined ? current.cron : update.cron;
		const nextInterval = update.intervalMs === undefined ? current.interval_ms : update.intervalMs;
		const timezone = update.timezone ?? current.timezone;
		validateScheduleFields({ cron: nextCron ?? undefined, intervalMs: nextInterval ?? undefined, timezone,
			notificationPolicy: update.notificationPolicy ?? (current.notification_policy as "always" | "changes_only") });
		const label = update.label ?? current.label;
		const prompt = update.prompt ?? current.prompt;
		validateText(label, "Schedule label", 256);
		validateText(prompt, "Schedule prompt");
		const dueAt = update.dueAt !== undefined ? timestamp(update.dueAt)
			: update.cron !== undefined || update.timezone !== undefined ? (nextCron ? cronNext(nextCron, timezone, Date.now()) : current.due_at)
			: current.due_at;
		const policy = update.notificationPolicy ?? current.notification_policy;
		this.db.prepare(`UPDATE assistant_schedules SET label = ?, prompt = ?, due_at = ?, interval_ms = ?, cron = ?, timezone = ?, notification_policy = ? WHERE id = ?`)
			.run(label, prompt, dueAt, nextInterval, nextCron, timezone, policy, id);
		return toSchedule(this.db.prepare("SELECT * FROM assistant_schedules WHERE id = ?").get(id) as unknown as ScheduleRow);
	}

	/** Queue an immediate execution unless this routine already has queued or running work. */
	runScheduleNow(id: string): boolean {
		validateId(id);
		return transaction(this.db, () => {
			const schedule = this.db.prepare("SELECT * FROM assistant_schedules WHERE id = ? AND enabled = 1").get(id) as ScheduleRow | undefined;
			if (!schedule || this.inbox.hasActiveScheduleRun(id)) return false;
			validateSource(schedule.source);
			return this.inbox.enqueue({ id: `schedule:manual:${randomUUID()}`, text: schedule.prompt, source: schedule.source, scheduleId: id });
		});
	}

	/** Enqueue at most one event per due schedule, then skip missed interval occurrences. */
	enqueueDueSchedules(now = Date.now()): number {
		if (!Number.isFinite(now)) throw new Error("now must be a finite millisecond timestamp");
		const at = Math.trunc(now);
		return transaction(this.db, () => {
			let enqueued = 0;
			const due = this.db.prepare("SELECT * FROM assistant_schedules WHERE enabled = 1 AND paused = 0 AND due_at <= ? ORDER BY due_at, id").all(at) as unknown as ScheduleRow[];
			const advance = this.db.prepare("UPDATE assistant_schedules SET due_at = ?, enabled = ? WHERE id = ? AND enabled = 1");
			for (const row of due) {
				const requestId = `schedule:${createHash("sha256").update(`${row.id}\0${row.due_at}`).digest("hex")}`;
				if (!this.inbox.hasActiveScheduleRun(row.id)) {
					validateSource(row.source);
					if (this.inbox.enqueue({ id: requestId, text: row.prompt, source: row.source, scheduleId: row.id }, at)) enqueued++;
				}
				if (row.interval_ms === null) {
					if (row.cron !== null) {
						advance.run(cronNext(row.cron, row.timezone, at), 1, row.id);
						continue;
					}
					advance.run(row.due_at, 0, row.id);
				} else {
					const periods = Math.floor((at - row.due_at) / row.interval_ms) + 1;
					const nextDueAt = row.due_at + periods * row.interval_ms;
					if (!Number.isSafeInteger(nextDueAt)) throw new Error(`Schedule ${row.id} next due time exceeds safe timestamp range`);
					advance.run(nextDueAt, 1, row.id);
				}
			}
			return enqueued;
		});
	}

	/** Save the latest result and decide whether it is delivered under the routine's notification policy. */
	private recordResult(scheduleId: string, response: string, notify: boolean): boolean {
		const schedule = this.db.prepare("SELECT notification_policy, last_result FROM assistant_schedules WHERE id = ?").get(scheduleId) as { notification_policy: string; last_result: string | null } | undefined;
		if (!schedule) return true;
		const shouldDeliver = schedule.notification_policy !== "changes_only" || (notify && response !== schedule.last_result);
		this.db.prepare("UPDATE assistant_schedules SET last_result = ?, last_notified_result = CASE WHEN ? THEN ? ELSE last_notified_result END WHERE id = ?")
			.run(response, shouldDeliver ? 1 : 0, response, scheduleId);
		return shouldDeliver;
	}
}
