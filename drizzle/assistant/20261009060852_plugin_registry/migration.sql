CREATE TABLE `plugins` (
	`name` text PRIMARY KEY,
	`description` text NOT NULL,
	`instructions` text,
	`entry` text NOT NULL,
	`version` text NOT NULL,
	`history_json` text NOT NULL,
	`enabled` integer NOT NULL,
	`last_error` text,
	CONSTRAINT "plugins_enabled" CHECK("enabled" IN (0, 1))
);
