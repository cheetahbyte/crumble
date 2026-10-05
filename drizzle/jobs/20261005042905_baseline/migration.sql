CREATE TABLE `job_notifications` (
	`job_id` text NOT NULL,
	`version` integer NOT NULL,
	`job_json` text NOT NULL,
	`acknowledged_at` integer,
	CONSTRAINT `job_notifications_pk` PRIMARY KEY(`job_id`, `version`)
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY,
	`project` text NOT NULL,
	`brief` text NOT NULL,
	`status` text NOT NULL,
	`question` text,
	`summary` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
