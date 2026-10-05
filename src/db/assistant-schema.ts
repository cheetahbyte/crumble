import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

const MAX_ID_LENGTH = 200;
const MAX_KEY_LENGTH = 256;
const MAX_TEXT_LENGTH = 32_000;
const MIN_INTERVAL_MS = 60_000;

/** Durable tenant-local memory entries. */
export const assistantMemory = sqliteTable(
	"assistant_memory",
	{
		key: text("key").primaryKey(),
		value_json: text("value_json").notNull(),
		updated_at: integer("updated_at").notNull(),
		current_revision: integer("current_revision"),
	},
	(table) => [check("assistant_memory_key_length", sql`length(${table.key}) BETWEEN 1 AND ${sql.raw(String(MAX_KEY_LENGTH))}`)],
);

export const assistantMemoryHistory = sqliteTable(
	"assistant_memory_history",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		key: text("key").notNull(),
		value_json: text("value_json").notNull(),
		reason: text("reason").notNull(),
		operation: text("operation", { enum: ["save", "rollback", "import"] }).notNull(),
		created_at: integer("created_at").notNull(),
	},
	(table) => [
		index("assistant_memory_history_key").on(table.key, sql`${table.id} DESC`),
		check("assistant_memory_history_operation", sql`${table.operation} IN ('save', 'rollback', 'import')`),
	],
);

export const assistantInbox = sqliteTable(
	"assistant_inbox",
	{
		id: text("id").primaryKey(),
		text: text("text").notNull(),
		source: text("source").notNull(),
		status: text("status").notNull(),
		response: text("response"),
		error: text("error"),
		created_at: integer("created_at").notNull(),
		updated_at: integer("updated_at").notNull(),
		schedule_id: text("schedule_id"),
	},
	(table) => [
		index("assistant_inbox_pending").on(table.status),
		check("assistant_inbox_id_length", sql`length(${table.id}) BETWEEN 1 AND ${sql.raw(String(MAX_ID_LENGTH))}`),
		check("assistant_inbox_text_length", sql`length(${table.text}) BETWEEN 1 AND ${sql.raw(String(MAX_TEXT_LENGTH))}`),
		check("assistant_inbox_source", sql`${table.source} IN ('terminal', 'discord', 'internal')`),
		check("assistant_inbox_status", sql`${table.status} IN ('pending', 'processing', 'completed', 'failed')`),
		check(
			"assistant_inbox_completed_response",
			sql`(${table.status} = 'completed' AND ${table.response} IS NOT NULL AND ${table.error} IS NULL) OR ${table.status} != 'completed'`,
		),
		check("assistant_inbox_failed_response", sql`(${table.status} = 'failed' AND ${table.response} IS NOT NULL) OR ${table.status} != 'failed'`),
	],
);

export const assistantDeliveries = sqliteTable("assistant_deliveries", {
	id: text("id")
			.primaryKey()
			.references(() => assistantInbox.id, { onDelete: "cascade" }),
	acknowledged_at: integer("acknowledged_at"),
});

export const assistantSchedules = sqliteTable(
	"assistant_schedules",
	{
		id: text("id").primaryKey(),
		label: text("label").notNull(),
		prompt: text("prompt").notNull(),
		due_at: integer("due_at").notNull(),
		interval_ms: integer("interval_ms"),
		source: text("source").notNull(),
		enabled: integer("enabled").notNull(),
		created_at: integer("created_at").notNull(),
		cron: text("cron"),
		timezone: text("timezone").notNull().default("UTC"),
		notification_policy: text("notification_policy").notNull().default("always"),
		last_result: text("last_result"),
		last_notified_result: text("last_notified_result"),
		paused: integer("paused").notNull().default(0),
	},
	(table) => [
		index("assistant_schedules_due").on(table.enabled, table.due_at),
		check("assistant_schedules_id_length", sql`length(${table.id}) BETWEEN 1 AND ${sql.raw(String(MAX_ID_LENGTH))}`),
		check("assistant_schedules_label_length", sql`length(${table.label}) BETWEEN 1 AND 256`),
		check("assistant_schedules_prompt_length", sql`length(${table.prompt}) BETWEEN 1 AND ${sql.raw(String(MAX_TEXT_LENGTH))}`),
		check("assistant_schedules_interval_ms", sql`${table.interval_ms} IS NULL OR ${table.interval_ms} >= ${sql.raw(String(MIN_INTERVAL_MS))}`),
		check("assistant_schedules_source", sql`${table.source} IN ('terminal', 'discord', 'internal')`),
		check("assistant_schedules_enabled", sql`${table.enabled} IN (0, 1)`),
		check("assistant_schedules_notification_policy", sql`${table.notification_policy} IN ('always', 'changes_only')`),
		check("assistant_schedules_paused", sql`${table.paused} IN (0, 1)`),
	],
);

export const learningHistory = sqliteTable("learning_history", {
	id: text("id").primaryKey(),
	request: text("request").notNull(),
	response: text("response").notNull(),
	source: text("source").notNull(),
	status: text("status", { enum: ["completed", "failed"] }).notNull(),
	created_at: integer("created_at").notNull(),
	updated_at: integer("updated_at").notNull(),
}, (table) => [check("learning_history_status", sql`${table.status} IN ('completed', 'failed')`)]);

export const learningSkills = sqliteTable(
	"learning_skills",
	{
		name: text("name").primaryKey(),
		current_version: integer("current_version").notNull(),
		next_version: integer("next_version").notNull(),
		enabled: integer("enabled").notNull(),
	},
	(table) => [
		check("learning_skills_name_length", sql`length(${table.name}) BETWEEN 1 AND 100`),
		check("learning_skills_enabled", sql`${table.enabled} IN (0, 1)`),
	],
);

export const learningSkillVersions = sqliteTable(
	"learning_skill_versions",
	{
		name: text("name")
			.notNull()
			.references(() => learningSkills.name, { onDelete: "cascade" }),
		version: integer("version").notNull(),
		description: text("description").notNull(),
		instructions: text("instructions").notNull(),
		source_request_id: text("source_request_id"),
		reason: text("reason"),
		created_at: integer("created_at").notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.name, table.version] }),
		check("learning_skill_versions_version", sql`${table.version} > 0`),
		check("learning_skill_versions_description_length", sql`length(${table.description}) BETWEEN 1 AND 500`),
		check("learning_skill_versions_instructions_length", sql`length(${table.instructions}) BETWEEN 1 AND 12000`),
	],
);

export const learningSettings = sqliteTable("learning_settings", {
	key: text("key").primaryKey(),
	value: text("value").notNull(),
});

export const learningDeletedSkills = sqliteTable("learning_deleted_skills", {
	name: text("name").primaryKey(),
	deleted_at: integer("deleted_at").notNull(),
});
