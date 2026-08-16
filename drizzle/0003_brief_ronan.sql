CREATE TABLE `confluence_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`cloud_id` text NOT NULL,
	`site_name` text NOT NULL,
	`site_url` text NOT NULL,
	`encrypted_access_token` text NOT NULL,
	`encrypted_refresh_token` text,
	`access_token_expires_at` text NOT NULL,
	`scopes` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_confluence_connections_workspace_cloud` ON `confluence_connections` (`workspace_id`,`cloud_id`);--> statement-breakpoint
CREATE TABLE `source_associations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`repository_source_id` text NOT NULL,
	`documentation_source_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`documentation_source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_source_associations_unique_pair` ON `source_associations` (`workspace_id`,`repository_source_id`,`documentation_source_id`);--> statement-breakpoint
CREATE INDEX `idx_source_associations_repository` ON `source_associations` (`repository_source_id`);--> statement-breakpoint
CREATE INDEX `idx_source_associations_documentation` ON `source_associations` (`documentation_source_id`);--> statement-breakpoint
ALTER TABLE `provider_connection_sessions` ADD `context_json` text;--> statement-breakpoint
ALTER TABLE `sources` ADD `confluence_connection_id` text REFERENCES confluence_connections(id);--> statement-breakpoint
ALTER TABLE `sources` ADD `canonical_url` text;