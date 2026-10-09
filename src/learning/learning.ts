import type { DatabaseSync } from "node:sqlite";
import type { InferSelectModel } from "drizzle-orm";
import { transaction } from "#db/database";
import type { learningHistory, learningSkillVersions, learningSkills } from "#db/assistant-schema";
import { assertText } from "#shared/text";

const MAX_SEARCH_QUERY = 512;
const MAX_SEARCH_LIMIT = 25;
const MAX_SNIPPET_LENGTH = 1_000;
const MAX_SKILL_NAME = 100;
const MAX_SKILL_DESCRIPTION = 500;
const MAX_SKILL_INSTRUCTIONS = 12_000;
const MAX_SKILL_REASON = 2_000;

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

export type SkillVersionMetadata = {
	version: number;
	createdAt: number;
	sourceRequestId?: string;
	reason?: string;
};

export type Skill = SkillSummary & { instructions: string; sourceRequestId?: string; reason?: string };

type HistoryRow = Pick<InferSelectModel<typeof learningHistory>, "id" | "source" | "status" | "created_at" | "updated_at"> & { snippet: string };
type TranscriptRow = InferSelectModel<typeof learningHistory>;
type SkillRow = Pick<InferSelectModel<typeof learningSkillVersions>, "name" | "description" | "instructions" | "version" | "source_request_id" | "reason"> &
	Pick<InferSelectModel<typeof learningSkills>, "enabled"> & { updated_at: number };

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
	const skill: Skill = {
		name: row.name,
		description: row.description,
		instructions: row.instructions,
		version: row.version,
		enabled: row.enabled === 1,
		updatedAt: row.updated_at,
	};
	if (row.source_request_id != null) skill.sourceRequestId = row.source_request_id;
	if (row.reason != null) skill.reason = row.reason;
	return skill;
}

function toSkillSummary(row: Omit<SkillRow, "instructions">): SkillSummary {
	return {
		name: row.name,
		description: row.description,
		version: row.version,
		enabled: row.enabled === 1,
		updatedAt: row.updated_at,
	};
}

/** Tenant-local transcript recall and reusable text procedures. The caller owns the database connection. */
export class LearningStore {
	private readonly db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.db = db;
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

	saveSkill(
		name: string,
		description: string,
		instructions: string,
		metadata: { sourceRequestId?: string; reason?: string } = {},
	): Skill {
		assertText(name, "Skill name", MAX_SKILL_NAME);
		assertText(description, "Skill description", MAX_SKILL_DESCRIPTION);
		assertText(instructions, "Skill instructions", MAX_SKILL_INSTRUCTIONS);
		if (metadata.sourceRequestId !== undefined) assertText(metadata.sourceRequestId, "Source request ID", 512);
		if (metadata.reason !== undefined) assertText(metadata.reason, "Skill reason", MAX_SKILL_REASON);
		const existing = this.readSkill(name);
		if (existing?.description === description && existing.instructions === instructions) return existing;
		const now = Date.now();
		const save = this.db.prepare(`
			INSERT INTO learning_skills(name, current_version, next_version, enabled) VALUES (?, 1, 2, 1)
			ON CONFLICT(name) DO UPDATE SET current_version = next_version, next_version = next_version + 1
		`);
		const getVersion = this.db.prepare("SELECT current_version, enabled FROM learning_skills WHERE name = ?");
		const insert = this.db.prepare(`
			INSERT INTO learning_skill_versions(name, version, description, instructions, source_request_id, reason, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`);
		return transaction(this.db, () => {
			save.run(name);
			this.db.prepare("DELETE FROM learning_deleted_skills WHERE name = ?").run(name);
			const current = getVersion.get(name) as { current_version: number; enabled: number };
			insert.run(name, current.current_version, description, instructions, metadata.sourceRequestId ?? null, metadata.reason ?? null, now);
			const skill = this.readSkill(name);
			if (!skill) throw new Error(`Unable to save skill ${name}`);
			return skill;
		});
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
		return rows.map(toSkillSummary);
	}

	/** Find enabled skills by lexical relevance. Instructions are used for ranking, never returned. */
	searchSkills(query: string, limit = 5): SkillSummary[] {
		assertText(query, "Search query", MAX_SEARCH_QUERY);
		if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) {
			throw new Error(`Search limit must be between 1 and ${MAX_SEARCH_LIMIT}`);
		}
		const tokens = [...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].slice(0, 32);
		if (tokens.length === 0) return [];
		const rows = this.db.prepare(`
			SELECT s.name, v.description, v.instructions, s.current_version AS version, s.enabled,
				v.created_at AS updated_at
			FROM learning_skills s
			JOIN learning_skill_versions v ON v.name = s.name AND v.version = s.current_version
			WHERE s.enabled = 1
		`).all() as unknown as SkillRow[];
		return rows.map((row) => {
			const fields = [row.name, row.description, row.instructions].map((field) => field.toLocaleLowerCase());
			let score = 0;
			for (const token of tokens) {
				if (fields[0]?.includes(token)) score += 4;
				if (fields[1]?.includes(token)) score += 2;
				if (fields[2]?.includes(token)) score += 1;
			}
			return { summary: toSkillSummary(row), score };
		}).filter(({ score }) => score > 0)
			.sort((a, b) => b.score - a.score || a.summary.name.localeCompare(b.summary.name, undefined, { sensitivity: "base" }))
			.slice(0, limit)
			.map(({ summary }) => summary);
	}

	readSkill(name: string): Skill | undefined {
		assertText(name, "Skill name", MAX_SKILL_NAME);
		const row = this.db.prepare(`
			SELECT s.name, v.description, v.instructions, v.version, s.enabled, v.created_at AS updated_at,
				v.source_request_id, v.reason
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

	skillHistory(name: string): SkillVersionMetadata[] {
		assertText(name, "Skill name", MAX_SKILL_NAME);
		const rows = this.db.prepare(`
			SELECT version, created_at, source_request_id, reason
			FROM learning_skill_versions WHERE name = ? ORDER BY version DESC
		`).all(name) as Array<{ version: number; created_at: number; source_request_id: string | null; reason: string | null }>;
		return rows.map((row) => {
			const metadata: SkillVersionMetadata = { version: row.version, createdAt: row.created_at };
			if (row.source_request_id !== null) metadata.sourceRequestId = row.source_request_id;
			if (row.reason !== null) metadata.reason = row.reason;
			return metadata;
		});
	}

	deleteSkill(name: string): boolean {
		assertText(name, "Skill name", MAX_SKILL_NAME);
		return transaction(this.db, () => {
			const changes = Number(this.db.prepare("DELETE FROM learning_skills WHERE name = ?").run(name).changes);
			if (changes > 0) {
				this.db.prepare("INSERT INTO learning_deleted_skills(name, deleted_at) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET deleted_at = excluded.deleted_at").run(name, Date.now());
			}
			return changes > 0;
		});
	}

	isSkillDeleted(name: string): boolean {
		assertText(name, "Skill name", MAX_SKILL_NAME);
		return this.db.prepare("SELECT 1 FROM learning_deleted_skills WHERE name = ?").get(name) !== undefined;
	}

	learningEnabled(): boolean {
		const row = this.db.prepare("SELECT value FROM learning_settings WHERE key = 'enabled'").get() as { value: string } | undefined;
		return row?.value !== "0";
	}

	setLearningEnabled(enabled: boolean): void {
		this.db.prepare(`
			INSERT INTO learning_settings(key, value) VALUES ('enabled', ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value
		`).run(enabled ? "1" : "0");
	}
}
