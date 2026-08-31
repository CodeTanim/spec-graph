import {
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
};

export const users = pgTable(
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

export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  ...timestamps,
});

export const workspaceMembers = pgTable(
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
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.userId] }),
    index("idx_workspace_members_user_id").on(table.userId),
  ],
);

export const providerConnectionSessions = pgTable(
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
    contextJson: text("context_json"),
    candidatesJson: text("candidates_json"),
    status: text("status", {
      enum: ["initiated", "authorized", "consumed", "failed"],
    })
      .notNull()
      .default("initiated"),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "string" }),
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

export const confluenceConnections = pgTable(
  "confluence_connections",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    cloudId: text("cloud_id").notNull(),
    siteName: text("site_name").notNull(),
    siteUrl: text("site_url").notNull(),
    encryptedAccessToken: text("encrypted_access_token").notNull(),
    encryptedRefreshToken: text("encrypted_refresh_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    scopes: text("scopes").notNull().default(""),
    status: text("status", {
      enum: ["active", "expired", "disconnected"],
    })
      .notNull()
      .default("active"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("idx_confluence_connections_workspace_cloud").on(
      table.workspaceId,
      table.cloudId,
    ),
  ],
);

export const githubInstallations = pgTable(
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

export const sources = pgTable(
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
    confluenceConnectionId: text("confluence_connection_id").references(
      () => confluenceConnections.id,
      { onDelete: "set null" },
    ),
    provider: text("provider", { enum: ["github", "confluence"] }).notNull(),
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    detail: text("detail").notNull().default(""),
    canonicalUrl: text("canonical_url"),
    defaultBranch: text("default_branch"),
    currentRevision: text("current_revision"),
    status: text("status", {
      enum: ["pending", "syncing", "connected", "error", "disconnected"],
    })
      .notNull()
      .default("pending"),
    lastError: text("last_error"),
    lastSyncedAt: timestamp("last_synced_at", {
      withTimezone: true,
      mode: "string",
    }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("idx_sources_workspace_provider_external").on(
      table.workspaceId,
      table.provider,
      table.externalId,
    ),
    index("idx_sources_workspace_status").on(table.workspaceId, table.status),
    uniqueIndex("idx_sources_workspace_id").on(table.workspaceId, table.id),
  ],
);

export const sourceGroups = pgTable(
  "source_groups",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("idx_source_groups_workspace_id").on(
      table.workspaceId,
      table.id,
    ),
    index("idx_source_groups_workspace").on(table.workspaceId),
  ],
);

export const sourceGroupMembers = pgTable(
  "source_group_members",
  {
    workspaceId: text("workspace_id").notNull(),
    groupId: text("group_id").notNull(),
    sourceId: text("source_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.groupId, table.sourceId] }),
    uniqueIndex("idx_source_group_members_source").on(table.sourceId),
    index("idx_source_group_members_workspace_group").on(
      table.workspaceId,
      table.groupId,
    ),
    foreignKey({
      columns: [table.workspaceId, table.groupId],
      foreignColumns: [sourceGroups.workspaceId, sourceGroups.id],
      name: "source_group_members_workspace_group_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.workspaceId, table.sourceId],
      foreignColumns: [sources.workspaceId, sources.id],
      name: "source_group_members_workspace_source_fk",
    }).onDelete("cascade"),
  ],
);

// Retained for one rollout so an older deployment can still be rolled back after
// the provider-neutral group backfill. Product code no longer reads or writes it.
export const sourceAssociations = pgTable(
  "source_associations",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    repositorySourceId: text("repository_source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    documentationSourceId: text("documentation_source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("idx_source_associations_unique_pair").on(
      table.workspaceId,
      table.repositorySourceId,
      table.documentationSourceId,
    ),
    index("idx_source_associations_repository").on(table.repositorySourceId),
    index("idx_source_associations_documentation").on(table.documentationSourceId),
  ],
);

export const artifacts = pgTable(
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

export const artifactVersions = pgTable(
  "artifact_versions",
  {
    id: text("id").primaryKey(),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    revision: text("revision").notNull(),
    contentHash: text("content_hash").notNull(),
    extractedText: text("extracted_text").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_artifact_versions_artifact_revision").on(
      table.artifactId,
      table.revision,
    ),
  ],
);

export const artifactAnalysisCursors = pgTable(
  "artifact_analysis_cursors",
  {
    artifactId: text("artifact_id")
      .primaryKey()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    revision: text("revision").notNull(),
    ...timestamps,
  },
);

export const graphNodes = pgTable(
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

export const relationships = pgTable(
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
    provenance: text("provenance", {
      enum: [
        "USER_DEFINED",
        "EXPLICIT_LINK",
        "EXACT_PATH",
        "IMPORT",
        "TEST_NAMING",
        "OPENAPI_ENTITY",
        "EXACT_IDENTIFIER",
        "SHARED_ENTITY",
        "SEMANTIC",
        "CO_CHANGE",
        "STRUCTURAL",
        "LEGACY",
      ],
    })
      .notNull()
      .default("LEGACY"),
    analyzerVersion: text("analyzer_version")
      .notNull()
      .default("deterministic-v1"),
    confidence: real("confidence").notNull().default(1),
    evidence: text("evidence").notNull().default(""),
    evidenceStartLine: integer("evidence_start_line"),
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

export const changeEvents = pgTable(
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
    changedArtifactsJson: text("changed_artifacts_json").notNull().default("[]"),
    // Private, bounded before/after snippets used by analysis. This is kept
    // separate from changedArtifactsJson because that metadata is returned by
    // the feed API and must never leak indexed source content.
    analysisScopeJson: text("analysis_scope_json").notNull().default("[]"),
    evidenceSummary: text("evidence_summary").notNull().default(""),
    sourceLabel: text("source_label").notNull(),
    sourceUrl: text("source_url"),
    beforeRevision: text("before_revision"),
    afterRevision: text("after_revision"),
    actor: text("actor"),
    occurredAt: timestamp("occurred_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_change_events_workspace_occurred").on(
      table.workspaceId,
      table.occurredAt,
    ),
  ],
);

export const analysisRuns = pgTable(
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
    maxAttempts: integer("max_attempts").notNull().default(3),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    workflowRunId: text("workflow_run_id"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
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

export const runAttempts = pgTable(
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
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "string" }),
  },
  (table) => [
    uniqueIndex("idx_run_attempts_run_attempt_stage").on(
      table.runId,
      table.attempt,
      table.stage,
    ),
  ],
);

export const semanticAnalysisAttempts = pgTable(
  "semantic_analysis_attempts",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => analysisRuns.id, { onDelete: "cascade" }),
    changedNodeId: text("changed_node_id").references(() => graphNodes.id, {
      onDelete: "set null",
    }),
    analyzerVersion: text("analyzer_version").notNull(),
    analyzerName: text("analyzer_name"),
    model: text("model"),
    status: text("status", { enum: ["succeeded", "fallback"] }).notNull(),
    inputCandidateCount: integer("input_candidate_count").notNull(),
    outputDecisionCount: integer("output_decision_count").notNull(),
    acceptedDecisionCount: integer("accepted_decision_count").notNull(),
    rejectedDecisionCount: integer("rejected_decision_count").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    estimatedCostMicros: integer("estimated_cost_micros"),
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_semantic_attempts_run_created").on(table.runId, table.createdAt),
    index("idx_semantic_attempts_changed_node").on(table.changedNodeId),
  ],
);

export const findings = pgTable(
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
    provenance: text("provenance", {
      enum: [
        "USER_DEFINED",
        "EXPLICIT_LINK",
        "EXACT_PATH",
        "IMPORT",
        "TEST_NAMING",
        "OPENAPI_ENTITY",
        "EXACT_IDENTIFIER",
        "SHARED_ENTITY",
        "SEMANTIC",
        "CO_CHANGE",
        "STRUCTURAL",
        "LEGACY",
      ],
    })
      .notNull()
      .default("LEGACY"),
    analyzerVersion: text("analyzer_version")
      .notNull()
      .default("deterministic-v1"),
    status: text("status", { enum: ["open", "resolved", "dismissed"] })
      .notNull()
      .default("open"),
    deduplicationKey: text("deduplication_key").notNull(),
    impactFingerprint: text("impact_fingerprint"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("idx_findings_run_deduplication").on(
      table.runId,
      table.deduplicationKey,
    ),
    uniqueIndex("idx_findings_impact_fingerprint").on(table.impactFingerprint),
    index("idx_findings_run_status").on(table.runId, table.status),
  ],
);

export const findingEvidence = pgTable(
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
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("idx_finding_evidence_finding").on(table.findingId)],
);

export const findingActions = pgTable(
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
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_finding_actions_finding_created").on(
      table.findingId,
      table.createdAt,
    ),
  ],
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    analysisRunId: text("analysis_run_id").references(() => analysisRuns.id, {
      onDelete: "set null",
    }),
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
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "string" }).notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true, mode: "string" }),
    errorMessage: text("error_message"),
  },
  (table) => [
    uniqueIndex("idx_webhook_deliveries_provider_delivery").on(
      table.provider,
      table.providerDeliveryId,
    ),
  ],
);
