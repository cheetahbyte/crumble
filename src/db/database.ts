import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { readMigrationFiles, type MigrationMeta } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/node-sqlite";
import { migrate } from "drizzle-orm/node-sqlite/migrator";

export type DatabaseKind = "assistant" | "jobs";

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const tables = (db: DatabaseSync) => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map(({ name }) => name);
const columns = (db: DatabaseSync, name: string) => (db.prepare(`PRAGMA table_info(${quote(name)})`).all() as Array<{ name: string }>).map(({ name }) => name);

function hasMigrations(db: DatabaseSync): boolean {
	return tables(db).includes("__drizzle_migrations") && Boolean(db.prepare("SELECT 1 FROM __drizzle_migrations LIMIT 1").get());
}

/** One-time adoption of databases created before Drizzle. All later upgrades use its migrator. */
function adoptLegacy(db: DatabaseSync, baseline: MigrationMeta): void {
	if (hasMigrations(db)) return;
	const target = new DatabaseSync(":memory:");
	try {
		for (const statement of baseline.sql) target.exec(statement);
		const targetTables = tables(target);
		const existing = targetTables.filter((name) => tables(db).includes(name));
		if (existing.length === 0) return;

		// Rebuild rather than retaining weaker constraints from historical ADD COLUMN upgrades.
		db.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
		try {
			if (hasMigrations(db)) { db.exec("COMMIT"); return; }
			const sequences = db.prepare("SELECT name FROM sqlite_master WHERE name = 'sqlite_sequence'").get()
				? db.prepare("SELECT name, seq FROM sqlite_sequence").all() as Array<{ name: string; seq: number }> : [];
			for (const name of existing) {
				const unknown = columns(db, name).filter((column) => !columns(target, name).includes(column));
				if (unknown.length) throw new Error(`Cannot adopt ${name}: unrecognized columns ${unknown.join(", ")}`);
			}
			const objects = db.prepare("SELECT type, name, tbl_name FROM sqlite_master WHERE type IN ('index', 'trigger') AND sql IS NOT NULL").all() as Array<{ type: string; name: string; tbl_name: string }>;
			for (const object of objects) if (existing.includes(object.tbl_name)) db.exec(`DROP ${object.type} ${quote(object.name)}`);
			if (targetTables.includes("learning_history")) db.exec("DROP TABLE IF EXISTS learning_history_fts");
			for (const name of existing) db.exec(`ALTER TABLE ${quote(name)} RENAME TO ${quote(`__legacy_${name}`)}`);
			for (const statement of baseline.sql) db.exec(statement);
			for (const name of existing) {
				const sharedColumns = columns(db, `__legacy_${name}`).map(quote).join(", ");
				db.exec(`INSERT INTO ${quote(name)} (${sharedColumns}) SELECT ${sharedColumns} FROM ${quote(`__legacy_${name}`)}`);
			}
			for (const name of existing) db.exec(`DROP TABLE ${quote(`__legacy_${name}`)}`);
			for (const { name, seq } of sequences) if (targetTables.includes(name)) {
				db.prepare("UPDATE sqlite_sequence SET seq = max(seq, ?) WHERE name = ?").run(seq, name);
			}
			if (db.prepare("PRAGMA foreign_key_check").get()) throw new Error("Legacy database contains invalid foreign keys");
			// Match the pinned Drizzle migrator's journal format, using its own file metadata.
			db.exec(`CREATE TABLE IF NOT EXISTS __drizzle_migrations (
				id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC, name TEXT, applied_at TEXT
			)`);
			db.prepare("INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at) VALUES (?, ?, ?, ?)")
				.run(baseline.hash, baseline.folderMillis, baseline.name, new Date().toISOString());
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		} finally {
			db.exec("PRAGMA foreign_keys = ON");
		}
	} finally {
		target.close();
	}
}

/** Open a tenant-local database and apply checked-in migrations before exposing it. */
export function openDatabase(path: string, kind: DatabaseKind): DatabaseSync {
	const db = new DatabaseSync(path);
	try {
		db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
		const migrationsFolder = fileURLToPath(new URL(`../../drizzle/${kind}/`, import.meta.url));
		const [baseline] = readMigrationFiles({ migrationsFolder });
		if (!baseline) throw new Error(`Missing ${kind} baseline migration`);
		adoptLegacy(db, baseline);
		migrate(drizzle({ client: db }), { migrationsFolder });
		return db;
	} catch (error) {
		db.close();
		throw error;
	}
}
