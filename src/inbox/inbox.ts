import type { DatabaseSync } from "node:sqlite";
import type { InferSelectModel } from "drizzle-orm";
import { transaction } from "../db/database.ts";
import type { assistantInbox } from "../db/assistant-schema.ts";

export { InboxProcessor, type AssistantReply, type InboxOptions } from "./processor.ts";

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
	scheduleId?: string;
}

/** Decides whether a finished scheduled request is delivered. Runs inside the completion transaction. */
export type DeliveryPolicy = (scheduleId: string, response: string, notify: boolean) => boolean;

type InboundRow = InferSelectModel<typeof assistantInbox>;

const SOURCES: readonly string[] = ["terminal", "discord", "internal"];
const STATUSES: readonly string[] = ["pending", "processing", "completed", "failed"];
const MAX_ID_LENGTH = 200;
const MAX_TEXT_LENGTH = 32_000;
const MAX_RESPONSE_LENGTH = 1_000_000;

export function validateSource(source: string): asserts source is InboundSource {
	if (!SOURCES.includes(source)) throw new Error(`Unsupported request source: ${JSON.stringify(source)}`);
}

export function validateId(id: string): void {
	if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_LENGTH || id.trim() !== id) {
		throw new Error(`ID must be a non-empty string of at most ${MAX_ID_LENGTH} characters`);
	}
}

export function validateText(text: string, field: string, maxLength = MAX_TEXT_LENGTH): void {
	if (typeof text !== "string" || text.trim().length === 0 || text.length > maxLength) {
		throw new Error(`${field} must be a non-empty string of at most ${maxLength} characters`);
	}
}

/** A bare "stop" interrupts the turn like /stop, so nobody has to know commands. */
export function isStopRequest(text: string): boolean {
	return /^\/stop(?:\s|$)|^stop[.!]*$/i.test(text.trim());
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

/** Tenant-local request inbox and reply outbox. The caller owns the database connection. */
export class Inbox {
	private readonly db: DatabaseSync;
	private deliveryPolicy: DeliveryPolicy = () => true;

	constructor(db: DatabaseSync) {
		this.db = db;
	}

	useDeliveryPolicy(policy: DeliveryPolicy): void {
		this.deliveryPolicy = policy;
	}

	/** Insert once by stable id. Returns false when that id was already accepted. */
	enqueue(input: EnqueueRequest, now = Date.now()): boolean {
		validateId(input.id);
		validateText(input.text, "Request text");
		validateSource(input.source);
		return Number(this.db.prepare(`
			INSERT INTO assistant_inbox (id, text, source, status, created_at, updated_at, schedule_id)
			VALUES (?, ?, ?, 'pending', ?, ?, ?) ON CONFLICT(id) DO NOTHING
		`).run(input.id, input.text, input.source, now, now, input.scheduleId ?? null).changes) > 0;
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
			if (request.schedule_id === null || this.deliveryPolicy(request.schedule_id, response, notify)) this.queueDelivery(id);
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

	hasActiveScheduleRun(scheduleId: string): boolean {
		return Boolean(this.db.prepare("SELECT 1 FROM assistant_inbox WHERE schedule_id = ? AND status IN ('pending', 'processing') LIMIT 1").get(scheduleId));
	}

	private queueDelivery(id: string): void {
		this.db.prepare("INSERT INTO assistant_deliveries (id) VALUES (?) ON CONFLICT(id) DO UPDATE SET acknowledged_at = NULL").run(id);
	}
}
