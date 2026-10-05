import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openDatabase, type DatabaseKind } from "./database.ts";

function withDirectory(run: (directory: string) => void): void {
	const directory = mkdtempSync(join(tmpdir(), "crumble-db-migrations-"));
	try {
		run(directory);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

function schema(db: DatabaseSync, name: string): string {
	const row = db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(name) as { sql: string } | undefined;
	assert.ok(row, `expected sqlite object ${name}`);
	return row.sql;
}

function migrationRows(db: DatabaseSync): Array<{ name: string; hash: string }> {
	return db.prepare("SELECT name, hash FROM __drizzle_migrations ORDER BY id").all() as Array<{ name: string; hash: string }>;
}

function createLegacyAssistant(path: string): DatabaseSync {
	const db = new DatabaseSync(path);
	db.exec(`
		CREATE TABLE assistant_memory (
			key TEXT PRIMARY KEY,
			value_json TEXT NOT NULL,
			updated_at INTEGER NOT NULL
		);
		CREATE TABLE assistant_memory_history (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			key TEXT NOT NULL,
			value_json TEXT NOT NULL,
			reason TEXT NOT NULL,
			operation TEXT NOT NULL,
			created_at INTEGER NOT NULL
		);
		CREATE TABLE assistant_inbox (
			id TEXT PRIMARY KEY,
			text TEXT NOT NULL,
			source TEXT NOT NULL,
			status TEXT NOT NULL,
			response TEXT,
			error TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		);
		CREATE TABLE assistant_schedules (
			id TEXT PRIMARY KEY,
			label TEXT NOT NULL,
			prompt TEXT NOT NULL,
			due_at INTEGER NOT NULL,
			interval_ms INTEGER,
			source TEXT NOT NULL,
			enabled INTEGER NOT NULL,
			created_at INTEGER NOT NULL
		);
		INSERT INTO assistant_memory VALUES ('theme', '{"dark":true}', 100);
		INSERT INTO assistant_memory_history VALUES (41, 'theme', '{"dark":true}', 'old import', 'import', 100);
		INSERT INTO assistant_inbox VALUES ('old-inbox', 'remember this', 'terminal', 'completed', 'remembered', NULL, 100, 101);
		INSERT INTO assistant_schedules VALUES ('daily', 'Daily', 'Do the thing', 500, NULL, 'internal', 1, 100);
	`);
	return db;
}

function createLegacyLearning(path: string): DatabaseSync {
	const db = new DatabaseSync(path);
	db.exec(`
		CREATE TABLE learning_history (
			id TEXT PRIMARY KEY,
			request TEXT NOT NULL,
			response TEXT NOT NULL,
			source TEXT NOT NULL,
			status TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		);
		CREATE TABLE learning_skills (
			name TEXT PRIMARY KEY,
			current_version INTEGER NOT NULL,
			next_version INTEGER NOT NULL,
			enabled INTEGER NOT NULL
		);
		CREATE TABLE learning_skill_versions (
			name TEXT NOT NULL,
			version INTEGER NOT NULL,
			description TEXT NOT NULL,
			instructions TEXT NOT NULL,
			source_request_id TEXT,
			reason TEXT,
			created_at INTEGER NOT NULL,
			PRIMARY KEY (name, version)
		);
		INSERT INTO learning_history VALUES ('old-history', 'Where is the observatory?', 'It is north.', 'terminal', 'completed', 200, 201);
		INSERT INTO learning_skills VALUES ('navigation', 3, 4, 0);
		INSERT INTO learning_skill_versions VALUES ('navigation', 3, 'Find places', 'Use the map.', 'req-3', 'Imported old procedure', 202);
	`);
	return db;
}

function createLegacyJobs(path: string): DatabaseSync {
	const db = new DatabaseSync(path);
	db.exec(`
		CREATE TABLE jobs (
			id TEXT PRIMARY KEY,
			project TEXT NOT NULL,
			brief TEXT NOT NULL,
			status TEXT NOT NULL,
			question TEXT,
			summary TEXT,
			error TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		);
		CREATE TABLE job_notifications (
			job_id TEXT NOT NULL,
			version INTEGER NOT NULL,
			job_json TEXT NOT NULL,
			acknowledged_at INTEGER,
			PRIMARY KEY (job_id, version)
		);
		INSERT INTO jobs VALUES ('job-old', 'crumble', 'finish migration', 'waiting', 'pick a tool', NULL, NULL, 300, 301);
		INSERT INTO job_notifications VALUES ('job-old', 2, '{"status":"waiting"}', NULL);
	`);
	return db;
}

test("fresh databases migrate once and reopening does not add journal entries", () => {
	withDirectory((directory) => {
		for (const kind of ["assistant", "jobs"] as const) {
			const path = join(directory, `${kind}.db`);
			const first = openDatabase(path, kind);
			const firstRows = migrationRows(first);
			assert.ok(firstRows.length >= 1);
			first.close();
			const second = openDatabase(path, kind);
			assert.deepEqual(migrationRows(second), firstRows);
			second.close();
		}
	});
});

test("assistant legacy data is preserved with fresh constraints, indexes, and defaults", () => {
	withDirectory((directory) => {
		const path = join(directory, "assistant.db");
		const legacy = createLegacyAssistant(path);
		legacy.close();
		const upgraded = openDatabase(path, "assistant");
		try {
			assert.deepEqual({ ...upgraded.prepare("SELECT key, value_json, updated_at, current_revision FROM assistant_memory").get() as object }, {
				key: "theme", value_json: '{"dark":true}', updated_at: 100, current_revision: 42,
			});
			assert.deepEqual({ ...upgraded.prepare("SELECT id, schedule_id FROM assistant_inbox").get() as object }, { id: "old-inbox", schedule_id: null });
			assert.deepEqual({ ...upgraded.prepare("SELECT timezone, notification_policy, paused FROM assistant_schedules").get() as object }, {
				timezone: "UTC", notification_policy: "always", paused: 0,
			});
			for (const name of ["assistant_inbox_pending", "assistant_memory_history_key", "assistant_schedules_due"]) {
				assert.equal(upgraded.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(name) != null, true);
			}
			const freshPath = join(directory, "fresh.db");
			const fresh = openDatabase(freshPath, "assistant");
			try {
				for (const name of ["assistant_inbox", "assistant_memory", "assistant_memory_history", "assistant_schedules"]) {
					assert.equal(schema(upgraded, name), schema(fresh, name), `${name} schema differs after adoption`);
				}
			} finally { fresh.close(); }
		} finally { upgraded.close(); }
	});
});

test("learning legacy rows retain metadata and are searchable after FTS migration", () => {
	withDirectory((directory) => {
		const path = join(directory, "assistant.db");
		const legacy = createLegacyLearning(path);
		legacy.close();
		const db = openDatabase(path, "assistant");
		try {
			assert.deepEqual({ ...db.prepare("SELECT * FROM learning_history WHERE id = 'old-history'").get() as object }, {
				id: "old-history", request: "Where is the observatory?", response: "It is north.", source: "terminal", status: "completed", created_at: 200, updated_at: 201,
			});
			assert.deepEqual({ ...db.prepare("SELECT * FROM learning_skill_versions WHERE name = 'navigation'").get() as object }, {
				name: "navigation", version: 3, description: "Find places", instructions: "Use the map.", source_request_id: "req-3", reason: "Imported old procedure", created_at: 202,
			});
			assert.equal((db.prepare("SELECT enabled FROM learning_skills WHERE name = 'navigation'").get() as { enabled: number }).enabled, 0);
			assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'learning_history_fts'").get());
			assert.equal(db.prepare("SELECT rowid FROM learning_history_fts WHERE learning_history_fts MATCH 'observatory'").get()?.rowid, 1);
		} finally { db.close(); }
	});
});

test("jobs legacy rows and pending notifications are preserved", () => {
	withDirectory((directory) => {
		const path = join(directory, "jobs.db");
		const legacy = createLegacyJobs(path);
		legacy.close();
		const db = openDatabase(path, "jobs");
		try {
			assert.deepEqual({ ...db.prepare("SELECT * FROM jobs").get() as object }, {
				id: "job-old", project: "crumble", brief: "finish migration", status: "waiting", question: "pick a tool", summary: null, error: null, created_at: 300, updated_at: 301,
			});
			assert.deepEqual({ ...db.prepare("SELECT * FROM job_notifications").get() as object }, { job_id: "job-old", version: 2, job_json: '{"status":"waiting"}', acknowledged_at: null });
		} finally { db.close(); }
	});
});

test("invalid legacy rows roll back adoption without marking the baseline applied", () => {
	withDirectory((directory) => {
		const path = join(directory, "assistant.db");
		const legacy = new DatabaseSync(path);
		legacy.exec(`CREATE TABLE assistant_inbox (id TEXT PRIMARY KEY, text TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL, response TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL); INSERT INTO assistant_inbox VALUES ('bad', 'bad source', 'alien', 'pending', NULL, NULL, 1, 1);`);
		legacy.close();
		assert.throws(() => openDatabase(path, "assistant"));
		const check = new DatabaseSync(path);
		try {
			assert.deepEqual({ ...check.prepare("SELECT source FROM assistant_inbox WHERE id = 'bad'").get() as object }, { source: "alien" });
			assert.equal(check.prepare("SELECT 1 FROM sqlite_master WHERE name = '__drizzle_migrations'").get(), undefined);
		} finally { check.close(); }
	});
});

test("legacy AUTOINCREMENT sequence remains monotonic after the highest row was deleted", () => {
	withDirectory((directory) => {
		const path = join(directory, "assistant.db");
		const legacy = new DatabaseSync(path);
		legacy.exec("CREATE TABLE assistant_memory_history (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, value_json TEXT NOT NULL, reason TEXT NOT NULL, operation TEXT NOT NULL, created_at INTEGER NOT NULL); INSERT INTO assistant_memory_history VALUES (900, 'old', '{}', 'old', 'import', 1); DELETE FROM assistant_memory_history WHERE id = 900;");
		legacy.close();
		const db = openDatabase(path, "assistant");
		try {
			const row = db.prepare("INSERT INTO assistant_memory_history (key, value_json, reason, operation, created_at) VALUES ('new', '{}', 'new', 'import', 2) RETURNING id").get() as { id: number };
			assert.ok(row.id > 900);
		} finally { db.close(); }
	});
});

test("assistant and jobs databases remain isolated by file", () => {
	withDirectory((directory) => {
		const assistantPath = join(directory, "assistant.db");
		const jobsPath = join(directory, "jobs.db");
		const assistant = openDatabase(assistantPath, "assistant");
		const jobs = openDatabase(jobsPath, "jobs");
		try {
			assistant.prepare("INSERT INTO assistant_memory (key, value_json, updated_at) VALUES ('only-assistant', '{}', 1)").run();
			jobs.prepare("INSERT INTO jobs (id, project, brief, status, created_at, updated_at) VALUES ('only-job', 'p', 'b', 'running', 1, 1)").run();
			assert.equal(jobs.prepare("SELECT 1 FROM sqlite_master WHERE name = 'assistant_memory'").get(), undefined);
			assert.equal(assistant.prepare("SELECT 1 FROM sqlite_master WHERE name = 'jobs'").get(), undefined);
		} finally { assistant.close(); jobs.close(); }
	});
});
