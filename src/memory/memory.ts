import type { DatabaseSync } from "node:sqlite";
import type { InferSelectModel } from "drizzle-orm";
import { transaction } from "../db/database.ts";
import type { assistantMemory, assistantMemoryHistory } from "../db/assistant-schema.ts";
import { assertText } from "../shared/text.ts";

const MAX_MEMORY_KEY = 256;
const MAX_MEMORY_VALUE = 256_000;
const MAX_MEMORY_REASON = 2_000;

export interface MemoryEntry {
	key: string;
	value: unknown;
	updatedAt: number;
}

export interface MemoryRevision extends MemoryEntry {
	revision: number;
	reason: string;
	operation: "save" | "rollback" | "import";
}

type MemoryRow = Pick<InferSelectModel<typeof assistantMemory>, "key" | "value_json" | "updated_at">;
type MemoryRevisionRow = InferSelectModel<typeof assistantMemoryHistory>;

/** Tenant-local stable preferences and facts with revision history. The caller owns the database connection. */
export class MemoryStore {
	private readonly db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.db = db;
	}

	get(key: string): unknown | undefined {
		assertText(key, "Memory key", MAX_MEMORY_KEY);
		const row = this.db.prepare("SELECT value_json FROM assistant_memory WHERE key = ?").get(key) as { value_json: string } | undefined;
		return row ? JSON.parse(row.value_json) as unknown : undefined;
	}

	list(): MemoryEntry[] {
		const rows = this.db.prepare("SELECT key, value_json, updated_at FROM assistant_memory ORDER BY key").all() as unknown as MemoryRow[];
		return rows.map((row) => ({ key: row.key, value: JSON.parse(row.value_json) as unknown, updatedAt: row.updated_at }));
	}

	set(key: string, value: unknown, reason = "Updated memory"): void {
		assertText(key, "Memory key", MAX_MEMORY_KEY);
		assertText(reason, "Memory reason", MAX_MEMORY_REASON);
		let valueJson: string | undefined;
		try {
			valueJson = JSON.stringify(value);
		} catch (error) {
			throw new Error(`Memory value must be JSON-serializable: ${String(error)}`);
		}
		if (valueJson === undefined || valueJson.length > MAX_MEMORY_VALUE) {
			throw new Error(`Memory value must serialize to at most ${MAX_MEMORY_VALUE} characters`);
		}
		const json = valueJson;
		const now = Date.now();
		transaction(this.db, () => {
			const current = this.db.prepare("SELECT value_json FROM assistant_memory WHERE key = ?").get(key) as { value_json: string } | undefined;
			if (current?.value_json === json) return;
			const inserted = this.db.prepare(`INSERT INTO assistant_memory_history (key, value_json, reason, operation, created_at)
				VALUES (?, ?, ?, 'save', ?)`).run(key, json, reason, now);
			this.db.prepare(`INSERT INTO assistant_memory (key, value_json, updated_at, current_revision) VALUES (?, ?, ?, ?)
				ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at, current_revision = excluded.current_revision`)
				.run(key, json, now, Number(inserted.lastInsertRowid));
		});
	}

	history(key: string): MemoryRevision[] {
		assertText(key, "Memory key", MAX_MEMORY_KEY);
		const rows = this.db.prepare("SELECT id, key, value_json, reason, operation, created_at FROM assistant_memory_history WHERE key = ? ORDER BY id DESC")
			.all(key) as unknown as MemoryRevisionRow[];
		return rows.map((row) => ({
			revision: row.id,
			key: row.key,
			value: JSON.parse(row.value_json) as unknown,
			reason: row.reason,
			operation: row.operation,
			updatedAt: row.created_at,
		}));
	}

	/** Restore the save immediately before the currently selected save revision. */
	rollback(key: string): boolean {
		assertText(key, "Memory key", MAX_MEMORY_KEY);
		return transaction(this.db, () => {
			const current = this.db.prepare("SELECT value_json, current_revision FROM assistant_memory WHERE key = ?").get(key) as { value_json: string; current_revision: number | null } | undefined;
			if (!current || current.current_revision === null) return false;
			const prior = this.db.prepare(`SELECT id, value_json FROM assistant_memory_history
				WHERE key = ? AND id < ? AND operation IN ('save', 'import') ORDER BY id DESC LIMIT 1`)
				.get(key, current.current_revision) as { id: number; value_json: string } | undefined;
			if (!prior || prior.value_json === current.value_json) return false;
			const now = Date.now();
			this.db.prepare(`INSERT INTO assistant_memory_history (key, value_json, reason, operation, created_at)
				VALUES (?, ?, 'Rolled back to a previous revision', 'rollback', ?)`).run(key, prior.value_json, now);
			this.db.prepare("UPDATE assistant_memory SET value_json = ?, updated_at = ?, current_revision = ? WHERE key = ?")
				.run(prior.value_json, now, prior.id, key);
			return true;
		});
	}

	delete(key: string): boolean {
		assertText(key, "Memory key", MAX_MEMORY_KEY);
		return transaction(this.db, () => {
			this.db.prepare("DELETE FROM assistant_memory_history WHERE key = ?").run(key);
			return Number(this.db.prepare("DELETE FROM assistant_memory WHERE key = ?").run(key).changes) > 0;
		});
	}
}
