import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const jobs = sqliteTable("jobs", {
	id: text("id").primaryKey(),
	project: text("project").notNull(),
	brief: text("brief").notNull(),
	status: text("status").notNull(),
	question: text("question"),
	summary: text("summary"),
	error: text("error"),
	created_at: integer("created_at").notNull(),
	updated_at: integer("updated_at").notNull(),
});

export const jobNotifications = sqliteTable(
	"job_notifications",
	{
		job_id: text("job_id").notNull(),
		version: integer("version").notNull(),
		job_json: text("job_json").notNull(),
		acknowledged_at: integer("acknowledged_at"),
	},
	(table) => [primaryKey({ columns: [table.job_id, table.version] })],
);
