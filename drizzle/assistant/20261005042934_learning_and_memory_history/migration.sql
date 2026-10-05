-- Custom SQLite objects and data backfills accompany the TypeScript table schema.
INSERT INTO assistant_memory_history (key, value_json, reason, operation, created_at)
SELECT key, value_json, 'Imported existing memory', 'import', updated_at
FROM assistant_memory WHERE current_revision IS NULL;
--> statement-breakpoint
UPDATE assistant_memory SET current_revision = (
 SELECT max(id) FROM assistant_memory_history WHERE assistant_memory_history.key = assistant_memory.key
) WHERE current_revision IS NULL;
--> statement-breakpoint
CREATE VIRTUAL TABLE IF NOT EXISTS learning_history_fts USING fts5(
	request, response,
	content='learning_history', content_rowid='rowid',
	tokenize='unicode61'
);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS learning_history_ai AFTER INSERT ON learning_history BEGIN
	INSERT INTO learning_history_fts(rowid, request, response) VALUES (new.rowid, new.request, new.response);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS learning_history_ad AFTER DELETE ON learning_history BEGIN
	INSERT INTO learning_history_fts(learning_history_fts, rowid, request, response)
	VALUES ('delete', old.rowid, old.request, old.response);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS learning_history_au AFTER UPDATE ON learning_history BEGIN
	INSERT INTO learning_history_fts(learning_history_fts, rowid, request, response)
	VALUES ('delete', old.rowid, old.request, old.response);
	INSERT INTO learning_history_fts(rowid, request, response) VALUES (new.rowid, new.request, new.response);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS learning_inbox_ai AFTER INSERT ON assistant_inbox
WHEN new.status IN ('completed', 'failed') AND new.response IS NOT NULL BEGIN
	INSERT INTO learning_history(id, request, response, source, status, created_at, updated_at)
	VALUES (new.id, new.text, new.response, new.source, new.status, new.created_at, new.updated_at)
	ON CONFLICT(id) DO UPDATE SET request=excluded.request, response=excluded.response, source=excluded.source,
		status=excluded.status, created_at=excluded.created_at, updated_at=excluded.updated_at;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS learning_inbox_au AFTER UPDATE ON assistant_inbox BEGIN
	DELETE FROM learning_history WHERE id = old.id;
	INSERT INTO learning_history(id, request, response, source, status, created_at, updated_at)
	SELECT new.id, new.text, new.response, new.source, new.status, new.created_at, new.updated_at
	WHERE new.status IN ('completed', 'failed') AND new.response IS NOT NULL
	ON CONFLICT(id) DO UPDATE SET request=excluded.request, response=excluded.response, source=excluded.source,
		status=excluded.status, created_at=excluded.created_at, updated_at=excluded.updated_at;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS learning_inbox_ad AFTER DELETE ON assistant_inbox BEGIN
	DELETE FROM learning_history WHERE id = old.id;
END;
--> statement-breakpoint
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
--> statement-breakpoint
INSERT INTO learning_history_fts(learning_history_fts) VALUES ('rebuild');
