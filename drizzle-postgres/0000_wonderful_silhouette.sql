CREATE TABLE "analysis_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"source_id" text,
	"change_event_id" text,
	"requested_by_user_id" text,
	"trigger" text NOT NULL,
	"title" text NOT NULL,
	"target" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"error_message" text,
	"workflow_run_id" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifact_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"artifact_id" text NOT NULL,
	"revision" text NOT NULL,
	"content_hash" text NOT NULL,
	"extracted_text" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"external_id" text NOT NULL,
	"kind" text NOT NULL,
	"path" text NOT NULL,
	"title" text NOT NULL,
	"canonical_url" text,
	"current_revision" text,
	"content_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "change_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"source_id" text,
	"trigger" text NOT NULL,
	"title" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"evidence_summary" text DEFAULT '' NOT NULL,
	"source_label" text NOT NULL,
	"source_url" text,
	"before_revision" text,
	"after_revision" text,
	"actor" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "confluence_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"cloud_id" text NOT NULL,
	"site_name" text NOT NULL,
	"site_url" text NOT NULL,
	"encrypted_access_token" text NOT NULL,
	"encrypted_refresh_token" text,
	"access_token_expires_at" timestamp with time zone NOT NULL,
	"scopes" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finding_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"finding_id" text NOT NULL,
	"user_id" text NOT NULL,
	"action" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finding_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"finding_id" text NOT NULL,
	"artifact_version_id" text,
	"location" text NOT NULL,
	"start_line" integer,
	"end_line" integer,
	"excerpt" text NOT NULL,
	"source_url" text,
	"type" text DEFAULT 'source' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"changed_node_id" text,
	"affected_node_id" text,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"confidence" real DEFAULT 1 NOT NULL,
	"origin" text DEFAULT 'deterministic' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"deduplication_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_installations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"external_installation_id" text NOT NULL,
	"account_login" text NOT NULL,
	"account_type" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "graph_nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"artifact_id" text NOT NULL,
	"stable_key" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"start_line" integer,
	"end_line" integer,
	"content_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_connection_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"state_hash" text NOT NULL,
	"context_json" text,
	"candidates_json" text,
	"status" text DEFAULT 'initiated' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relationships" (
	"id" text PRIMARY KEY NOT NULL,
	"from_node_id" text NOT NULL,
	"to_node_id" text NOT NULL,
	"type" text NOT NULL,
	"origin" text DEFAULT 'deterministic' NOT NULL,
	"confidence" real DEFAULT 1 NOT NULL,
	"evidence" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"stage" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "source_associations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"repository_source_id" text NOT NULL,
	"documentation_source_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"github_installation_id" text,
	"confluence_connection_id" text,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"canonical_url" text,
	"default_branch" text,
	"current_revision" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_error" text,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_user_id" text NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text,
	"provider" text NOT NULL,
	"provider_delivery_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload_hash" text NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"processed_at" timestamp with time zone,
	"error_message" text
);
--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_members_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_change_event_id_change_events_id_fk" FOREIGN KEY ("change_event_id") REFERENCES "public"."change_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_events" ADD CONSTRAINT "change_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_events" ADD CONSTRAINT "change_events_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "confluence_connections" ADD CONSTRAINT "confluence_connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_actions" ADD CONSTRAINT "finding_actions_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_actions" ADD CONSTRAINT "finding_actions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_evidence" ADD CONSTRAINT "finding_evidence_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_evidence" ADD CONSTRAINT "finding_evidence_artifact_version_id_artifact_versions_id_fk" FOREIGN KEY ("artifact_version_id") REFERENCES "public"."artifact_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_run_id_analysis_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."analysis_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_changed_node_id_graph_nodes_id_fk" FOREIGN KEY ("changed_node_id") REFERENCES "public"."graph_nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_affected_node_id_graph_nodes_id_fk" FOREIGN KEY ("affected_node_id") REFERENCES "public"."graph_nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_nodes" ADD CONSTRAINT "graph_nodes_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_connection_sessions" ADD CONSTRAINT "provider_connection_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_connection_sessions" ADD CONSTRAINT "provider_connection_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_from_node_id_graph_nodes_id_fk" FOREIGN KEY ("from_node_id") REFERENCES "public"."graph_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_to_node_id_graph_nodes_id_fk" FOREIGN KEY ("to_node_id") REFERENCES "public"."graph_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_attempts" ADD CONSTRAINT "run_attempts_run_id_analysis_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."analysis_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_associations" ADD CONSTRAINT "source_associations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_associations" ADD CONSTRAINT "source_associations_repository_source_id_sources_id_fk" FOREIGN KEY ("repository_source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_associations" ADD CONSTRAINT "source_associations_documentation_source_id_sources_id_fk" FOREIGN KEY ("documentation_source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_github_installation_id_github_installations_id_fk" FOREIGN KEY ("github_installation_id") REFERENCES "public"."github_installations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_confluence_connection_id_confluence_connections_id_fk" FOREIGN KEY ("confluence_connection_id") REFERENCES "public"."confluence_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_analysis_runs_workspace_status_created" ON "analysis_runs" USING btree ("workspace_id","status","created_at");--> statement-breakpoint
CREATE INDEX "idx_analysis_runs_change_event" ON "analysis_runs" USING btree ("change_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_artifact_versions_artifact_revision" ON "artifact_versions" USING btree ("artifact_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_artifacts_source_external" ON "artifacts" USING btree ("source_id","external_id");--> statement-breakpoint
CREATE INDEX "idx_artifacts_source_kind" ON "artifacts" USING btree ("source_id","kind");--> statement-breakpoint
CREATE INDEX "idx_change_events_workspace_occurred" ON "change_events" USING btree ("workspace_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_confluence_connections_workspace_cloud" ON "confluence_connections" USING btree ("workspace_id","cloud_id");--> statement-breakpoint
CREATE INDEX "idx_finding_actions_finding_created" ON "finding_actions" USING btree ("finding_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_finding_evidence_finding" ON "finding_evidence" USING btree ("finding_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_findings_run_deduplication" ON "findings" USING btree ("run_id","deduplication_key");--> statement-breakpoint
CREATE INDEX "idx_findings_run_status" ON "findings" USING btree ("run_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_github_installations_workspace_external" ON "github_installations" USING btree ("workspace_id","external_installation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_graph_nodes_artifact_stable_key" ON "graph_nodes" USING btree ("artifact_id","stable_key");--> statement-breakpoint
CREATE INDEX "idx_graph_nodes_kind_name" ON "graph_nodes" USING btree ("kind","name");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_provider_connection_sessions_state_hash" ON "provider_connection_sessions" USING btree ("state_hash");--> statement-breakpoint
CREATE INDEX "idx_provider_connection_sessions_workspace_status" ON "provider_connection_sessions" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relationships_unique_edge" ON "relationships" USING btree ("from_node_id","to_node_id","type","origin");--> statement-breakpoint
CREATE INDEX "idx_relationships_from_node" ON "relationships" USING btree ("from_node_id");--> statement-breakpoint
CREATE INDEX "idx_relationships_to_node" ON "relationships" USING btree ("to_node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_run_attempts_run_attempt_stage" ON "run_attempts" USING btree ("run_id","attempt","stage");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_source_associations_unique_pair" ON "source_associations" USING btree ("workspace_id","repository_source_id","documentation_source_id");--> statement-breakpoint
CREATE INDEX "idx_source_associations_repository" ON "source_associations" USING btree ("repository_source_id");--> statement-breakpoint
CREATE INDEX "idx_source_associations_documentation" ON "source_associations" USING btree ("documentation_source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_sources_workspace_provider_external" ON "sources" USING btree ("workspace_id","provider","external_id");--> statement-breakpoint
CREATE INDEX "idx_sources_workspace_status" ON "sources" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_users_provider_user_id" ON "users" USING btree ("provider_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_webhook_deliveries_provider_delivery" ON "webhook_deliveries" USING btree ("provider","provider_delivery_id");--> statement-breakpoint
CREATE INDEX "idx_workspace_members_user_id" ON "workspace_members" USING btree ("user_id");