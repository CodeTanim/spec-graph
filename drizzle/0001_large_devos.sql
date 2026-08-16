CREATE TABLE `github_installations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`external_installation_id` text NOT NULL,
	`account_login` text NOT NULL,
	`account_type` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_github_installations_workspace_external` ON `github_installations` (`workspace_id`,`external_installation_id`);--> statement-breakpoint
CREATE TABLE `provider_connection_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`state_hash` text NOT NULL,
	`candidates_json` text,
	`status` text DEFAULT 'initiated' NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_provider_connection_sessions_state_hash` ON `provider_connection_sessions` (`state_hash`);--> statement-breakpoint
CREATE INDEX `idx_provider_connection_sessions_workspace_status` ON `provider_connection_sessions` (`workspace_id`,`status`);--> statement-breakpoint
ALTER TABLE `sources` ADD `github_installation_id` text REFERENCES github_installations(id);--> statement-breakpoint
ALTER TABLE `sources` ADD `last_error` text;--> statement-breakpoint
PRAGMA optimize;
