import { DatabaseSync } from "node:sqlite";

const MAX_SEARCH_QUERY = 512;
const MAX_SEARCH_LIMIT = 25;
const MAX_SNIPPET_LENGTH = 1_000;
const MAX_SKILL_NAME = 100;
const MAX_SKILL_DESCRIPTION = 500;
const MAX_SKILL_INSTRUCTIONS = 12_000;

export type HistoryMatch = {
	id: string;
	source: string;
	status: "completed" | "failed";
	createdAt: number;
	updatedAt: number;
	snippet: string;
};

export type HistoryTranscript = {
	id: string;
	request: string;
	response: string;
	source: string;
	status: "completed" | "failed";
	createdAt: number;
	updatedAt: number;
};

export type SkillSummary = {
	name: string;
	description: string;
	version: number;
	enabled: boolean;
	updatedAt: number;
};

export type Skill = SkillSummary & { instructions: string };

type HistoryRow = {
	id: string;
	source: string;
	status: "completed" | "failed";
	created_at: number;
	updated_at: number;
	snippet: string;
};

type TranscriptRow = {
	id: string;
	request: string;
	response: string;
	source: string;
	status: "completed" | "failed";
	created_at: number;
	updated_at: number;
};

type SkillRow = {
	name: string;
	description: string;
	instructions: string;
	version: number;
	enabled: number;
	updated_at: number;
};

function toHistory(row: HistoryRow): HistoryMatch {
	return {
		id: row.id,
		source: row.source,
		status: row.status,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		snippet: row.snippet.slice(0, MAX_SNIPPET_LENGTH),
	};
}

function toTranscript(row: TranscriptRow): HistoryTranscript {
	return {
		id: row.id,
		request: row.request,
		response: row.response,
		source: row.source,
		status: row.status,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function toSkill(row: SkillRow): Skill {
	return {
		name: row.name,
		description: row.description,
		instructions: row.instructions,
		version: row.version,
		enabled: row.enabled === 1,
		updatedAt: row.updated_at,
	};
}

function assertText(value: string, label: string, max: number): void {
	if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
		throw new Error(`${label} must contain 1 to ${max} characters`);
	}
}

/** Durable, tenant-local transcript recall and reusable text procedures. */
export class LearningStore {
	private readonly db: DatabaseSync;

	constructor(dbPath: string) {
		this.db = new DatabaseSync(dbPath);
		this.db.exec(`
			PRAGMA foreign_keys = ON;
			PRAGMA busy_timeout = 5000;
			PRAGMA journal_mode = WAL;
			CREATE TABLE IF NOT EXISTS learning_history (
				id TEXT PRIMARY KEY,
				request TEXT NOT NULL,
				response TEXT NOT NULL,
				source TEXT NOT NULL,
				status TEXT NOT NULL CHECK(status IN ('completed', 'failed')),
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE VIRTUAL TABLE IF NOT EXISTS learning_history_fts USING fts5(
				request, response,
				content='learning_history', content_rowid='rowid',
				tokenize='unicode61'
			);
			CREATE TRIGGER IF NOT EXISTS learning_history_ai AFTER INSERT ON learning_history BEGIN
				INSERT INTO learning_history_fts(rowid, request, response) VALUES (new.rowid, new.request, new.response);
			END;
			CREATE TRIGGER IF NOT EXISTS learning_history_ad AFTER DELETE ON learning_history BEGIN
				INSERT INTO learning_history_fts(learning_history_fts, rowid, request, response)
				VALUES ('delete', old.rowid, old.request, old.response);
			END;
			CREATE TRIGGER IF NOT EXISTS learning_history_au AFTER UPDATE ON learning_history BEGIN
				INSERT INTO learning_history_fts(learning_history_fts, rowid, request, response)
				VALUES ('delete', old.rowid, old.request, old.response);
				INSERT INTO learning_history_fts(rowid, request, response) VALUES (new.rowid, new.request, new.response);
			END;
			CREATE TRIGGER IF NOT EXISTS learning_inbox_ai AFTER INSERT ON assistant_inbox
			WHEN new.status IN ('completed', 'failed') AND new.response IS NOT NULL BEGIN
				INSERT INTO learning_history(id, request, response, source, status, created_at, updated_at)
				VALUES (new.id, new.text, new.response, new.source, new.status, new.created_at, new.updated_at)
				ON CONFLICT(id) DO UPDATE SET request=excluded.request, response=excluded.response, source=excluded.source,
					status=excluded.status, created_at=excluded.created_at, updated_at=excluded.updated_at;
			END;
			CREATE TRIGGER IF NOT EXISTS learning_inbox_au AFTER UPDATE ON assistant_inbox BEGIN
				DELETE FROM learning_history WHERE id = old.id;
				INSERT INTO learning_history(id, request, response, source, status, created_at, updated_at)
				SELECT new.id, new.text, new.response, new.source, new.status, new.created_at, new.updated_at
				WHERE new.status IN ('completed', 'failed') AND new.response IS NOT NULL
				ON CONFLICT(id) DO UPDATE SET request=excluded.request, response=excluded.response, source=excluded.source,
					status=excluded.status, created_at=excluded.created_at, updated_at=excluded.updated_at;
			END;
			CREATE TRIGGER IF NOT EXISTS learning_inbox_ad AFTER DELETE ON assistant_inbox BEGIN
				DELETE FROM learning_history WHERE id = old.id;
			END;
			CREATE TABLE IF NOT EXISTS learning_skills (
				name TEXT PRIMARY KEY CHECK(length(name) BETWEEN 1 AND ${MAX_SKILL_NAME}),
				current_version INTEGER NOT NULL,
				next_version INTEGER NOT NULL,
				enabled INTEGER NOT NULL CHECK(enabled IN (0, 1))
			);
			CREATE TABLE IF NOT EXISTS learning_skill_versions (
				name TEXT NOT NULL REFERENCES learning_skills(name) ON DELETE CASCADE,
				version INTEGER NOT NULL CHECK(version > 0),
				description TEXT NOT NULL CHECK(length(description) BETWEEN 1 AND ${MAX_SKILL_DESCRIPTION}),
				instructions TEXT NOT NULL CHECK(length(instructions) BETWEEN 1 AND ${MAX_SKILL_INSTRUCTIONS}),
				created_at INTEGER NOT NULL,
				PRIMARY KEY(name, version)
			);
		`);
		this.backfillHistory();
	}

	private backfillHistory(): void {
		this.db.exec(`
			INSERT INTO learning_history(id, request, response, source, status, created_at, updated_at)
			SELECT id, text, response, source, status, created_at, updated_at
			FROM assistant_inbox
			WHERE status IN ('completed', 'failed') AND response IS NOT NULL
			ON CONFLICT(id) DO UPDATE SET
				request = excluded.request,
				response = excluded.response,
				source = excluded.source,
				status = excluded.status,
				created_at = excluded.created_at,
				updated_at = excluded.updated_at
			WHERE learning_history.request IS NOT excluded.request
				OR learning_history.response IS NOT excluded.response
				OR learning_history.source IS NOT excluded.source
				OR learning_history.status IS NOT excluded.status
				OR learning_history.created_at IS NOT excluded.created_at
				OR learning_history.updated_at IS NOT excluded.updated_at;
		`);
	}

	searchHistory(query: string, limit = 10, offset = 0): HistoryMatch[] {
		assertText(query, "Search query", MAX_SEARCH_QUERY);
		if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) {
			throw new Error(`Search limit must be between 1 and ${MAX_SEARCH_LIMIT}`);
		}
		if (!Number.isInteger(offset) || offset < 0 || offset > 100_000) throw new Error("Search offset is out of range");

		// FTS5 has its own query language. Extract plain words and quote each token so
		// user text like `OR *` can only match those literal terms, never alter the query.
		const tokens = query.match(/[\p{L}\p{N}]+/gu)?.slice(0, 16) ?? [];
		if (tokens.length === 0) return [];
		const match = tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
		const rows = this.db.prepare(`
			SELECT h.id, h.source, h.status, h.created_at, h.updated_at,
				snippet(learning_history_fts, -1, '[', ']', ' … ', 20) AS snippet
			FROM learning_history_fts
			JOIN learning_history h ON h.rowid = learning_history_fts.rowid
			WHERE learning_history_fts MATCH ?
			ORDER BY bm25(learning_history_fts), h.created_at DESC, h.id
			LIMIT ? OFFSET ?
		`).all(match, limit, offset) as unknown as HistoryRow[];
		return rows.map(toHistory);
	}

	readHistory(id: string): HistoryTranscript | undefined {
		assertText(id, "History id", 512);
		const row = this.db.prepare(`
			SELECT id, request, response, source, status, created_at, updated_at
			FROM learning_history WHERE id = ? AND status IN ('completed', 'failed')
		`).get(id) as TranscriptRow | undefined;
		return row ? toTranscript(row) : undefined;
	}

	saveSkill(name: string, description: string, instructions: string): Skill {
		assertText(name, "Skill name", MAX_SKILL_NAME);
		assertText(description, "Skill description", MAX_SKILL_DESCRIPTION);
		assertText(instructions, "Skill instructions", MAX_SKILL_INSTRUCTIONS);
		const now = Date.now();
		const save = this.db.prepare(`
			INSERT INTO learning_skills(name, current_version, next_version, enabled) VALUES (?, 1, 2, 1)
			ON CONFLICT(name) DO UPDATE SET current_version = next_version, next_version = next_version + 1
		`);
		const getVersion = this.db.prepare("SELECT current_version, enabled FROM learning_skills WHERE name = ?");
		const insert = this.db.prepare(`
			INSERT INTO learning_skill_versions(name, version, description, instructions, created_at)
			VALUES (?, ?, ?, ?, ?)
		`);
		this.db.exec("BEGIN IMMEDIATE");
		try {
			save.run(name);
			const current = getVersion.get(name) as { current_version: number; enabled: number };
			insert.run(name, current.current_version, description, instructions, now);
			const skill = this.readSkill(name);
			if (!skill) throw new Error(`Unable to save skill ${name}`);
			this.db.exec("COMMIT");
			return skill;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	listSkills(limit = 100): SkillSummary[] {
		if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Skill list limit must be between 1 and 100");
		const rows = this.db.prepare(`
			SELECT s.name, v.description, s.current_version AS version, s.enabled, v.created_at AS updated_at
			FROM learning_skills s
			JOIN learning_skill_versions v ON v.name = s.name AND v.version = s.current_version
			ORDER BY s.name COLLATE NOCASE
			LIMIT ?
		`).all(limit) as unknown as Array<Omit<SkillRow, "instructions">>;
		return rows.map((row) => ({
			name: row.name,
			description: row.description,
			version: row.version,
			enabled: row.enabled === 1,
			updatedAt: row.updated_at,
		}));
	}

	readSkill(name: string): Skill | undefined {
		assertText(name, "Skill name", MAX_SKILL_NAME);
		const row = this.db.prepare(`
			SELECT s.name, v.description, v.instructions, v.version, s.enabled, v.created_at AS updated_at
			FROM learning_skills s
			JOIN learning_skill_versions v ON v.name = s.name AND v.version = s.current_version
			WHERE s.name = ?
		`).get(name) as SkillRow | undefined;
		return row ? toSkill(row) : undefined;
	}

	enableSkill(name: string): boolean {
		assertText(name, "Skill name", MAX_SKILL_NAME);
		return Number(this.db.prepare("UPDATE learning_skills SET enabled = 1 WHERE name = ? AND enabled = 0").run(name).changes) > 0;
	}

	disableSkill(name: string): boolean {
		assertText(name, "Skill name", MAX_SKILL_NAME);
		return Number(this.db.prepare("UPDATE learning_skills SET enabled = 0 WHERE name = ? AND enabled = 1").run(name).changes) > 0;
	}

	rollbackSkill(name: string, version?: number): Skill | undefined {
		assertText(name, "Skill name", MAX_SKILL_NAME);
		const current = this.db.prepare("SELECT current_version FROM learning_skills WHERE name = ?").get(name) as { current_version: number } | undefined;
		if (!current) return undefined;
		const target = version ?? current.current_version - 1;
		if (!Number.isInteger(target) || target < 1 || target >= current.current_version) return undefined;
		const exists = this.db.prepare("SELECT 1 FROM learning_skill_versions WHERE name = ? AND version = ?").get(name, target);
		if (!exists) return undefined;
		this.db.prepare("UPDATE learning_skills SET current_version = ? WHERE name = ?").run(target, name);
		return this.readSkill(name);
	}

	close(): void {
		this.db.close();
	}
}
