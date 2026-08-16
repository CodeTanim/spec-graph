CREATE TABLE `analysis_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`source_id` text,
	`change_event_id` text,
	`requested_by_user_id` text,
	`trigger` text NOT NULL,
	`title` text NOT NULL,
	`target` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`error_code` text,
	`error_message` text,
	`started_at` text,
	`completed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`change_event_id`) REFERENCES `change_events`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`requested_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_analysis_runs_workspace_status_created` ON `analysis_runs` (`workspace_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_analysis_runs_change_event` ON `analysis_runs` (`change_event_id`);--> statement-breakpoint
CREATE TABLE `artifact_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`artifact_id` text NOT NULL,
	`revision` text NOT NULL,
	`content_hash` text NOT NULL,
	`extracted_text` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_artifact_versions_artifact_revision` ON `artifact_versions` (`artifact_id`,`revision`);--> statement-breakpoint
CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`external_id` text NOT NULL,
	`kind` text NOT NULL,
	`path` text NOT NULL,
	`title` text NOT NULL,
	`canonical_url` text,
	`current_revision` text,
	`content_hash` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_artifacts_source_external` ON `artifacts` (`source_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `idx_artifacts_source_kind` ON `artifacts` (`source_id`,`kind`);--> statement-breakpoint
CREATE TABLE `change_events` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`source_id` text,
	`trigger` text NOT NULL,
	`title` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`evidence_summary` text DEFAULT '' NOT NULL,
	`source_label` text NOT NULL,
	`source_url` text,
	`before_revision` text,
	`after_revision` text,
	`actor` text,
	`occurred_at` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_change_events_workspace_occurred` ON `change_events` (`workspace_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `finding_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`finding_id` text NOT NULL,
	`user_id` text NOT NULL,
	`action` text NOT NULL,
	`note` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`finding_id`) REFERENCES `findings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_finding_actions_finding_created` ON `finding_actions` (`finding_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `finding_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`finding_id` text NOT NULL,
	`artifact_version_id` text,
	`location` text NOT NULL,
	`start_line` integer,
	`end_line` integer,
	`excerpt` text NOT NULL,
	`source_url` text,
	`type` text DEFAULT 'source' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`finding_id`) REFERENCES `findings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`artifact_version_id`) REFERENCES `artifact_versions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_finding_evidence_finding` ON `finding_evidence` (`finding_id`);--> statement-breakpoint
CREATE TABLE `findings` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`changed_node_id` text,
	`affected_node_id` text,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`confidence` real DEFAULT 1 NOT NULL,
	`origin` text DEFAULT 'deterministic' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`deduplication_key` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `analysis_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`changed_node_id`) REFERENCES `graph_nodes`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`affected_node_id`) REFERENCES `graph_nodes`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_findings_run_deduplication` ON `findings` (`run_id`,`deduplication_key`);--> statement-breakpoint
CREATE INDEX `idx_findings_run_status` ON `findings` (`run_id`,`status`);--> statement-breakpoint
CREATE TABLE `graph_nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`artifact_id` text NOT NULL,
	`stable_key` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`start_line` integer,
	`end_line` integer,
	`content_hash` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_graph_nodes_artifact_stable_key` ON `graph_nodes` (`artifact_id`,`stable_key`);--> statement-breakpoint
CREATE INDEX `idx_graph_nodes_kind_name` ON `graph_nodes` (`kind`,`name`);--> statement-breakpoint
CREATE TABLE `relationships` (
	`id` text PRIMARY KEY NOT NULL,
	`from_node_id` text NOT NULL,
	`to_node_id` text NOT NULL,
	`type` text NOT NULL,
	`origin` text DEFAULT 'deterministic' NOT NULL,
	`confidence` real DEFAULT 1 NOT NULL,
	`evidence` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`from_node_id`) REFERENCES `graph_nodes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_node_id`) REFERENCES `graph_nodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_relationships_unique_edge` ON `relationships` (`from_node_id`,`to_node_id`,`type`,`origin`);--> statement-breakpoint
CREATE INDEX `idx_relationships_from_node` ON `relationships` (`from_node_id`);--> statement-breakpoint
CREATE INDEX `idx_relationships_to_node` ON `relationships` (`to_node_id`);--> statement-breakpoint
CREATE TABLE `run_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`attempt` integer NOT NULL,
	`stage` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`error_code` text,
	`error_message` text,
	`started_at` text NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `analysis_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_run_attempts_run_attempt_stage` ON `run_attempts` (`run_id`,`attempt`,`stage`);--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`provider` text NOT NULL,
	`external_id` text NOT NULL,
	`name` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`default_branch` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`last_synced_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_sources_workspace_provider_external` ON `sources` (`workspace_id`,`provider`,`external_id`);--> statement-breakpoint
CREATE INDEX `idx_sources_workspace_status` ON `sources` (`workspace_id`,`status`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_user_id` text NOT NULL,
	`email` text NOT NULL,
	`display_name` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_users_provider_user_id` ON `users` (`provider_user_id`);--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text,
	`provider` text NOT NULL,
	`provider_delivery_id` text NOT NULL,
	`event_type` text NOT NULL,
	`payload_hash` text NOT NULL,
	`status` text DEFAULT 'received' NOT NULL,
	`received_at` text NOT NULL,
	`processed_at` text,
	`error_message` text,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_webhook_deliveries_provider_delivery` ON `webhook_deliveries` (`provider`,`provider_delivery_id`);--> statement-breakpoint
CREATE TABLE `workspace_members` (
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`workspace_id`, `user_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_workspace_members_user_id` ON `workspace_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
PRAGMA optimize;
