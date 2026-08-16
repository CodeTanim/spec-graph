import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const timestamps = {
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
};

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    providerUserId: text("provider_user_id").notNull(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("idx_users_provider_user_id").on(table.providerUserId),
  ],
);

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  ...timestamps,
});

export const workspaceMembers = sqliteTable(
  "workspace_members",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "member"] })
      .notNull()
      .default("member"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.userId] }),
    index("idx_workspace_members_user_id").on(table.userId),
  ],
);

export const providerConnectionSessions = sqliteTable(
  "provider_connection_sessions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider", { enum: ["github", "confluence"] }).notNull(),
    stateHash: text("state_hash").notNull(),
    candidatesJson: text("candidates_json"),
    status: text("status", {
      enum: ["initiated", "authorized", "consumed", "failed"],
    })
      .notNull()
      .default("initiated"),
    expiresAt: text("expires_at").notNull(),
    consumedAt: text("consumed_at"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("idx_provider_connection_sessions_state_hash").on(
      table.stateHash,
    ),
    index("idx_provider_connection_sessions_workspace_status").on(
      table.workspaceId,
      table.status,
    ),
  ],
);

export const githubInstallations = sqliteTable(
  "github_installations",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    externalInstallationId: text("external_installation_id").notNull(),
    accountLogin: text("account_login").notNull(),
    accountType: text("account_type").notNull(),
    status: text("status", {
      enum: ["active", "suspended", "disconnected"],
    })
      .notNull()
      .default("active"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("idx_github_installations_workspace_external").on(
      table.workspaceId,
      table.externalInstallationId,
    ),
  ],
);

export const sources = sqliteTable(
  "sources",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    githubInstallationId: text("github_installation_id").references(
      () => githubInstallations.id,
      { onDelete: "set null" },
    ),
    provider: text("provider", { enum: ["github", "confluence"] }).notNull(),
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    detail: text("detail").notNull().default(""),
    defaultBranch: text("default_branch"),
    currentRevision: text("current_revision"),
    status: text("status", {
      enum: ["pending", "syncing", "connected", "error", "disconnected"],
    })
      .notNull()
      .default("pending"),
    lastError: text("last_error"),
    lastSyncedAt: text("last_synced_at"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("idx_sources_workspace_provider_external").on(
      table.workspaceId,
      table.provider,
      table.externalId,
    ),
    index("idx_sources_workspace_status").on(table.workspaceId, table.status),
  ],
);

export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    kind: text("kind", {
      enum: ["code", "test", "markdown", "openapi", "confluence"],
    }).notNull(),
    path: text("path").notNull(),
    title: text("title").notNull(),
    canonicalUrl: text("canonical_url"),
    currentRevision: text("current_revision"),
    contentHash: text("content_hash"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("idx_artifacts_source_external").on(
      table.sourceId,
      table.externalId,
    ),
    index("idx_artifacts_source_kind").on(table.sourceId, table.kind),
  ],
);

export const artifactVersions = sqliteTable(
  "artifact_versions",
  {
    id: text("id").primaryKey(),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    revision: text("revision").notNull(),
    contentHash: text("content_hash").notNull(),
    extractedText: text("extracted_text").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_artifact_versions_artifact_revision").on(
      table.artifactId,
      table.revision,
    ),
  ],
);

export const graphNodes = sqliteTable(
  "graph_nodes",
  {
    id: text("id").primaryKey(),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    stableKey: text("stable_key").notNull(),
    kind: text("kind", {
      enum: ["file", "symbol", "endpoint", "schema", "doc_section", "test"],
    }).notNull(),
    name: text("name").notNull(),
    startLine: integer("start_line"),
    endLine: integer("end_line"),
    contentHash: text("content_hash"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("idx_graph_nodes_artifact_stable_key").on(
      table.artifactId,
      table.stableKey,
    ),
    index("idx_graph_nodes_kind_name").on(table.kind, table.name),
  ],
);

export const relationships = sqliteTable(
  "relationships",
  {
    id: text("id").primaryKey(),
    fromNodeId: text("from_node_id")
      .notNull()
      .references(() => graphNodes.id, { onDelete: "cascade" }),
    toNodeId: text("to_node_id")
      .notNull()
      .references(() => graphNodes.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    origin: text("origin", { enum: ["deterministic", "semantic", "hybrid"] })
      .notNull()
      .default("deterministic"),
    confidence: real("confidence").notNull().default(1),
    evidence: text("evidence").notNull().default(""),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("idx_relationships_unique_edge").on(
      table.fromNodeId,
      table.toNodeId,
      table.type,
      table.origin,
    ),
    index("idx_relationships_from_node").on(table.fromNodeId),
    index("idx_relationships_to_node").on(table.toNodeId),
  ],
);

export const changeEvents = sqliteTable(
  "change_events",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourceId: text("source_id").references(() => sources.id, {
      onDelete: "set null",
    }),
    trigger: text("trigger", {
      enum: ["manual", "github", "confluence", "scheduled"],
    }).notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull().default(""),
    evidenceSummary: text("evidence_summary").notNull().default(""),
    sourceLabel: text("source_label").notNull(),
    sourceUrl: text("source_url"),
    beforeRevision: text("before_revision"),
    afterRevision: text("after_revision"),
    actor: text("actor"),
    occurredAt: text("occurred_at").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_change_events_workspace_occurred").on(
      table.workspaceId,
      table.occurredAt,
    ),
  ],
);

export const analysisRuns = sqliteTable(
  "analysis_runs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourceId: text("source_id").references(() => sources.id, {
      onDelete: "set null",
    }),
    changeEventId: text("change_event_id").references(() => changeEvents.id, {
      onDelete: "set null",
    }),
    requestedByUserId: text("requested_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    trigger: text("trigger", {
      enum: ["manual", "github", "confluence", "scheduled"],
    }).notNull(),
    title: text("title").notNull(),
    target: text("target").notNull(),
    status: text("status", {
      enum: ["queued", "running", "succeeded", "failed"],
    })
      .notNull()
      .default("queued"),
    progress: integer("progress").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    ...timestamps,
  },
  (table) => [
    index("idx_analysis_runs_workspace_status_created").on(
      table.workspaceId,
      table.status,
      table.createdAt,
    ),
    index("idx_analysis_runs_change_event").on(table.changeEventId),
  ],
);

export const runAttempts = sqliteTable(
  "run_attempts",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => analysisRuns.id, { onDelete: "cascade" }),
    attempt: integer("attempt").notNull(),
    stage: text("stage").notNull(),
    status: text("status", { enum: ["running", "succeeded", "failed"] })
      .notNull()
      .default("running"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
  },
  (table) => [
    uniqueIndex("idx_run_attempts_run_attempt_stage").on(
      table.runId,
      table.attempt,
      table.stage,
    ),
  ],
);

export const findings = sqliteTable(
  "findings",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => analysisRuns.id, { onDelete: "cascade" }),
    changedNodeId: text("changed_node_id").references(() => graphNodes.id, {
      onDelete: "set null",
    }),
    affectedNodeId: text("affected_node_id").references(() => graphNodes.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    confidence: real("confidence").notNull().default(1),
    origin: text("origin", { enum: ["deterministic", "semantic", "hybrid"] })
      .notNull()
      .default("deterministic"),
    status: text("status", { enum: ["open", "resolved", "dismissed"] })
      .notNull()
      .default("open"),
    deduplicationKey: text("deduplication_key").notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("idx_findings_run_deduplication").on(
      table.runId,
      table.deduplicationKey,
    ),
    index("idx_findings_run_status").on(table.runId, table.status),
  ],
);

export const findingEvidence = sqliteTable(
  "finding_evidence",
  {
    id: text("id").primaryKey(),
    findingId: text("finding_id")
      .notNull()
      .references(() => findings.id, { onDelete: "cascade" }),
    artifactVersionId: text("artifact_version_id").references(
      () => artifactVersions.id,
      { onDelete: "set null" },
    ),
    location: text("location").notNull(),
    startLine: integer("start_line"),
    endLine: integer("end_line"),
    excerpt: text("excerpt").notNull(),
    sourceUrl: text("source_url"),
    type: text("type", { enum: ["source", "relationship", "semantic"] })
      .notNull()
      .default("source"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_finding_evidence_finding").on(table.findingId)],
);

export const findingActions = sqliteTable(
  "finding_actions",
  {
    id: text("id").primaryKey(),
    findingId: text("finding_id")
      .notNull()
      .references(() => findings.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    action: text("action", { enum: ["dismiss", "resolve", "reopen"] }).notNull(),
    note: text("note"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_finding_actions_finding_created").on(
      table.findingId,
      table.createdAt,
    ),
  ],
);

export const webhookDeliveries = sqliteTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id").references(() => sources.id, {
      onDelete: "set null",
    }),
    provider: text("provider", { enum: ["github", "confluence"] }).notNull(),
    providerDeliveryId: text("provider_delivery_id").notNull(),
    eventType: text("event_type").notNull(),
    payloadHash: text("payload_hash").notNull(),
    status: text("status", { enum: ["received", "processed", "ignored", "failed"] })
      .notNull()
      .default("received"),
    receivedAt: text("received_at").notNull(),
    processedAt: text("processed_at"),
    errorMessage: text("error_message"),
  },
  (table) => [
    uniqueIndex("idx_webhook_deliveries_provider_delivery").on(
      table.provider,
      table.providerDeliveryId,
    ),
  ],
);
