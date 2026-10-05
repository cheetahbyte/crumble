CREATE TABLE `assistant_deliveries` (
	`id` text PRIMARY KEY,
	`acknowledged_at` integer,
	CONSTRAINT `fk_assistant_deliveries_id_assistant_inbox_id_fk` FOREIGN KEY (`id`) REFERENCES `assistant_inbox`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `assistant_inbox` (
	`id` text PRIMARY KEY,
	`text` text NOT NULL,
	`source` text NOT NULL,
	`status` text NOT NULL,
	`response` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`schedule_id` text,
	CONSTRAINT "assistant_inbox_id_length" CHECK(length("id") BETWEEN 1 AND 200),
	CONSTRAINT "assistant_inbox_text_length" CHECK(length("text") BETWEEN 1 AND 32000),
	CONSTRAINT "assistant_inbox_source" CHECK("source" IN ('terminal', 'discord', 'internal')),
	CONSTRAINT "assistant_inbox_status" CHECK("status" IN ('pending', 'processing', 'completed', 'failed')),
	CONSTRAINT "assistant_inbox_completed_response" CHECK(("status" = 'completed' AND "response" IS NOT NULL AND "error" IS NULL) OR "status" != 'completed'),
	CONSTRAINT "assistant_inbox_failed_response" CHECK(("status" = 'failed' AND "response" IS NOT NULL) OR "status" != 'failed')
);
--> statement-breakpoint
CREATE TABLE `assistant_memory` (
	`key` text PRIMARY KEY,
	`value_json` text NOT NULL,
	`updated_at` integer NOT NULL,
	`current_revision` integer,
	CONSTRAINT "assistant_memory_key_length" CHECK(length("key") BETWEEN 1 AND 256)
);
--> statement-breakpoint
CREATE TABLE `assistant_memory_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`key` text NOT NULL,
	`value_json` text NOT NULL,
	`reason` text NOT NULL,
	`operation` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "assistant_memory_history_operation" CHECK("operation" IN ('save', 'rollback', 'import'))
);
--> statement-breakpoint
CREATE TABLE `assistant_schedules` (
	`id` text PRIMARY KEY,
	`label` text NOT NULL,
	`prompt` text NOT NULL,
	`due_at` integer NOT NULL,
	`interval_ms` integer,
	`source` text NOT NULL,
	`enabled` integer NOT NULL,
	`created_at` integer NOT NULL,
	`cron` text,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`notification_policy` text DEFAULT 'always' NOT NULL,
	`last_result` text,
	`last_notified_result` text,
	`paused` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "assistant_schedules_id_length" CHECK(length("id") BETWEEN 1 AND 200),
	CONSTRAINT "assistant_schedules_label_length" CHECK(length("label") BETWEEN 1 AND 256),
	CONSTRAINT "assistant_schedules_prompt_length" CHECK(length("prompt") BETWEEN 1 AND 32000),
	CONSTRAINT "assistant_schedules_interval_ms" CHECK("interval_ms" IS NULL OR "interval_ms" >= 60000),
	CONSTRAINT "assistant_schedules_source" CHECK("source" IN ('terminal', 'discord', 'internal')),
	CONSTRAINT "assistant_schedules_enabled" CHECK("enabled" IN (0, 1)),
	CONSTRAINT "assistant_schedules_notification_policy" CHECK("notification_policy" IN ('always', 'changes_only')),
	CONSTRAINT "assistant_schedules_paused" CHECK("paused" IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE `learning_deleted_skills` (
	`name` text PRIMARY KEY,
	`deleted_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `learning_history` (
	`id` text PRIMARY KEY,
	`request` text NOT NULL,
	`response` text NOT NULL,
	`source` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "learning_history_status" CHECK("status" IN ('completed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE `learning_settings` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `learning_skill_versions` (
	`name` text NOT NULL,
	`version` integer NOT NULL,
	`description` text NOT NULL,
	`instructions` text NOT NULL,
	`source_request_id` text,
	`reason` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `learning_skill_versions_pk` PRIMARY KEY(`name`, `version`),
	CONSTRAINT `fk_learning_skill_versions_name_learning_skills_name_fk` FOREIGN KEY (`name`) REFERENCES `learning_skills`(`name`) ON DELETE CASCADE,
	CONSTRAINT "learning_skill_versions_version" CHECK("version" > 0),
	CONSTRAINT "learning_skill_versions_description_length" CHECK(length("description") BETWEEN 1 AND 500),
	CONSTRAINT "learning_skill_versions_instructions_length" CHECK(length("instructions") BETWEEN 1 AND 12000)
);
--> statement-breakpoint
CREATE TABLE `learning_skills` (
	`name` text PRIMARY KEY,
	`current_version` integer NOT NULL,
	`next_version` integer NOT NULL,
	`enabled` integer NOT NULL,
	CONSTRAINT "learning_skills_name_length" CHECK(length("name") BETWEEN 1 AND 100),
	CONSTRAINT "learning_skills_enabled" CHECK("enabled" IN (0, 1))
);
--> statement-breakpoint
CREATE INDEX `assistant_inbox_pending` ON `assistant_inbox` (`status`);--> statement-breakpoint
CREATE INDEX `assistant_memory_history_key` ON `assistant_memory_history` (`key`,"id" DESC);--> statement-breakpoint
CREATE INDEX `assistant_schedules_due` ON `assistant_schedules` (`enabled`,`due_at`);