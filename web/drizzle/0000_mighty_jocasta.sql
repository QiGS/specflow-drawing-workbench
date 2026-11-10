CREATE TABLE `specflow_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`ip_hash` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`error_code` text
);
--> statement-breakpoint
CREATE INDEX `specflow_owner_created` ON `specflow_jobs` (`owner`,`created_at`);--> statement-breakpoint
CREATE INDEX `specflow_status_expires` ON `specflow_jobs` (`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `specflow_ip_created` ON `specflow_jobs` (`ip_hash`,`created_at`);