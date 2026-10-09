import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { InferSelectModel } from "drizzle-orm";
import { transaction } from "./db/database.ts";
import type { assistantInbox, assistantSchedules } from "./db/assistant-schema.ts";
import { validateTimezone } from "./paths.ts";
import { CronExpressionParser } from "cron-parser";

export type InboundSource = "terminal" | "discord" | "internal";
export type InboundStatus = "pending" | "processing" | "completed" | "failed";

export interface InboundRequest {
	id: string;
	text: string;
	source: InboundSource;
	status: InboundStatus;
	response: string | null;
	error: string | null;
	createdAt: number;
	updatedAt: number;
	scheduleId: string | null;
}

export interface Delivery {
	id: string;
	response: string;
	source: InboundSource;
	status: "completed" | "failed";
}

export interface EnqueueRequest {
	id: string;
	text: string;
	source: InboundSource;
}

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

type InboundRow = InferSelectModel<typeof assistantInbox>;
type ScheduleRow = InferSelectModel<typeof assistantSchedules>;

const SOURCES: readonly string[] = ["terminal", "discord", "internal"];
const STATUSES: readonly string[] = ["pending", "processing", "completed", "failed"];
const MAX_ID_LENGTH = 200;
const MAX_TEXT_LENGTH = 32_000;
const MAX_RESPONSE_LENGTH = 1_000_000;
const MIN_INTERVAL_MS = 60_000;

function validateSource(source: string): asserts source is InboundSource {
	if (!SOURCES.includes(source)) throw new Error(`Unsupported request source: ${JSON.stringify(source)}`);
}

function validateId(id: string): void {
	if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_LENGTH || id.trim() !== id) {
		throw new Error(`ID must be a non-empty string of at most ${MAX_ID_LENGTH} characters`);
	}
}

function validateText(text: string, field: string, maxLength = MAX_TEXT_LENGTH): void {
	if (typeof text !== "string" || text.trim().length === 0 || text.length > maxLength) {
		throw new Error(`${field} must be a non-empty string of at most ${maxLength} characters`);
	}
}

function toInbound(row: InboundRow): InboundRequest {
	if (!STATUSES.includes(row.status)) throw new Error(`Request ${row.id} has unknown status ${row.status}`);
	validateSource(row.source);
	return {
		id: row.id,
		text: row.text,
		source: row.source,
		status: row.status as InboundStatus,
		response: row.response,
		error: row.error,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		scheduleId: row.schedule_id ?? null,
	};
}

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

/** Tenant-local request inbox/outbox and schedules. The caller owns the database connection. */
export class AssistantState {
	private readonly db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.db = db;
	}

	/** Insert once by stable id. Returns false when that id was already accepted. */
	enqueue(input: EnqueueRequest): boolean {
		validateId(input.id);
		validateText(input.text, "Request text");
		validateSource(input.source);
		const now = Date.now();
		return Number(this.db.prepare(`
			INSERT INTO assistant_inbox (id, text, source, status, created_at, updated_at)
			VALUES (?, ?, ?, 'pending', ?, ?) ON CONFLICT(id) DO NOTHING
		`).run(input.id, input.text, input.source, now, now).changes) > 0;
	}

	get(id: string): InboundRequest | undefined {
		validateId(id);
		const row = this.db.prepare("SELECT * FROM assistant_inbox WHERE id = ?").get(id) as InboundRow | undefined;
		return row ? toInbound(row) : undefined;
	}

	nextPending(): InboundRequest | undefined {
		const row = this.db.prepare("SELECT * FROM assistant_inbox WHERE status = 'pending' ORDER BY rowid LIMIT 1").get() as InboundRow | undefined;
		return row ? toInbound(row) : undefined;
	}

	markProcessing(id: string): boolean {
		validateId(id);
		return Number(this.db.prepare("UPDATE assistant_inbox SET status = 'processing', updated_at = ? WHERE id = ? AND status = 'pending'").run(Date.now(), id).changes) > 0;
	}

	complete(id: string, response: string, notify = true): boolean {
		validateId(id);
		if (typeof response !== "string" || response.length > MAX_RESPONSE_LENGTH) throw new Error(`Response must be a string of at most ${MAX_RESPONSE_LENGTH} characters`);
		return transaction(this.db, () => {
			const now = Date.now();
			const result = this.db.prepare(`UPDATE assistant_inbox
				SET status = 'completed', response = ?, error = NULL, updated_at = ? WHERE id = ? AND status = 'processing'`).run(response, now, id);
			if (Number(result.changes) === 0) return false;
			const request = this.db.prepare("SELECT schedule_id FROM assistant_inbox WHERE id = ?").get(id) as { schedule_id: string | null };
			let shouldDeliver = true;
			if (request.schedule_id !== null) {
				const schedule = this.db.prepare("SELECT notification_policy, last_result FROM assistant_schedules WHERE id = ?").get(request.schedule_id) as { notification_policy: string; last_result: string | null } | undefined;
				if (schedule) {
					shouldDeliver = schedule.notification_policy !== "changes_only" || (notify && response !== schedule.last_result);
					this.db.prepare("UPDATE assistant_schedules SET last_result = ?, last_notified_result = CASE WHEN ? THEN ? ELSE last_notified_result END WHERE id = ?")
						.run(response, shouldDeliver ? 1 : 0, response, request.schedule_id);
				}
			}
			if (shouldDeliver) this.queueDelivery(id);
			return true;
		});
	}

	fail(id: string, error: string): boolean {
		validateId(id);
		validateText(error, "Error", MAX_TEXT_LENGTH);
		return transaction(this.db, () => {
			const result = this.db.prepare(`UPDATE assistant_inbox
				SET status = 'failed', response = ?, error = ?, updated_at = ? WHERE id = ? AND status = 'processing'`).run(error, error, Date.now(), id);
			if (Number(result.changes) === 0) return false;
			this.queueDelivery(id);
			return true;
		});
	}

	/** Convert abandoned work to a durable failure; interrupted requests are never replayed. */
	recoverInterrupted(): InboundRequest[] {
		const interruptedText = "Request was interrupted when the application stopped. It was not replayed automatically.";
		const now = Date.now();
		const rows = transaction(this.db, () => {
			const rows = this.db.prepare("SELECT * FROM assistant_inbox WHERE status = 'processing' ORDER BY rowid").all() as unknown as InboundRow[];
			for (const row of rows) {
				this.db.prepare("UPDATE assistant_inbox SET status = 'failed', response = ?, error = ?, updated_at = ? WHERE id = ? AND status = 'processing'")
					.run(interruptedText, interruptedText, now, row.id);
				this.queueDelivery(row.id);
			}
			return rows;
		});
		return rows.map((row) => ({ ...toInbound(row), status: "failed", response: interruptedText, error: interruptedText, updatedAt: now }));
	}

	pendingDeliveries(): Delivery[] {
		const rows = this.db.prepare(`SELECT i.id, i.response, i.source, i.status
			FROM assistant_deliveries d JOIN assistant_inbox i ON i.id = d.id
			WHERE d.acknowledged_at IS NULL ORDER BY d.rowid`).all() as unknown as Array<{ id: string; response: string | null; source: string; status: string }>;
		return rows.map((row) => {
			validateSource(row.source);
			if (row.response === null || (row.status !== "completed" && row.status !== "failed")) {
				throw new Error(`Delivery ${row.id} has invalid inbox state ${row.status}`);
			}
			return { id: row.id, response: row.response, source: row.source, status: row.status };
		});
	}

	acknowledgeDelivery(id: string): boolean {
		validateId(id);
		return Number(this.db.prepare("UPDATE assistant_deliveries SET acknowledged_at = ? WHERE id = ? AND acknowledged_at IS NULL").run(Date.now(), id).changes) > 0;
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
			if (!schedule || this.hasActiveScheduleRun(id)) return false;
			const requestId = `schedule:manual:${randomUUID()}`;
			const at = Date.now();
			const inserted = this.db.prepare(`INSERT INTO assistant_inbox (id, text, source, status, created_at, updated_at, schedule_id)
				VALUES (?, ?, ?, 'pending', ?, ?, ?)`).run(requestId, schedule.prompt, schedule.source, at, at, id);
			return Number(inserted.changes) > 0;
		});
	}

	private hasActiveScheduleRun(id: string): boolean {
		return Boolean(this.db.prepare("SELECT 1 FROM assistant_inbox WHERE schedule_id = ? AND status IN ('pending', 'processing') LIMIT 1").get(id));
	}

	private queueDelivery(id: string): void {
		this.db.prepare("INSERT INTO assistant_deliveries (id) VALUES (?) ON CONFLICT(id) DO UPDATE SET acknowledged_at = NULL").run(id);
	}

	/** Enqueue at most one event per due schedule, then skip missed interval occurrences. */
	enqueueDueSchedules(now = Date.now()): number {
		if (!Number.isFinite(now)) throw new Error("now must be a finite millisecond timestamp");
		const at = Math.trunc(now);
		return transaction(this.db, () => {
			let enqueued = 0;
			const due = this.db.prepare("SELECT * FROM assistant_schedules WHERE enabled = 1 AND paused = 0 AND due_at <= ? ORDER BY due_at, id").all(at) as unknown as ScheduleRow[];
			const insert = this.db.prepare(`INSERT INTO assistant_inbox (id, text, source, status, created_at, updated_at, schedule_id)
				VALUES (?, ?, ?, 'pending', ?, ?, ?) ON CONFLICT(id) DO NOTHING`);
			const advance = this.db.prepare("UPDATE assistant_schedules SET due_at = ?, enabled = ? WHERE id = ? AND enabled = 1");
			for (const row of due) {
				const requestId = `schedule:${createHash("sha256").update(`${row.id}\0${row.due_at}`).digest("hex")}`;
				if (!this.hasActiveScheduleRun(row.id)) {
					const inserted = insert.run(requestId, row.prompt, row.source, at, at, row.id);
					if (Number(inserted.changes) > 0) enqueued++;
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
}
