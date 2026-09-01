import { and, count, desc, eq, inArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb, type SpecGraphDb } from "../../db";
import {
  analysisRuns,
  artifacts,
  changeEvents,
  findingActions,
  findingEvidence,
  findings,
  graphNodes,
  relationships,
  sourceGroupMembers,
  sourceGroups,
  sources,
} from "../../db/schema";
import type {
  AffectedArtifact,
  ArtifactKind,
  ChangedArtifact,
  ChangeFilter,
  ChangeItem,
  ChangeListResponse,
  FindingAction,
  RunItem,
  RunListResponse,
  RetryRunResponse,
  SourceItem,
  SourceGroup,
  SourceListResponse,
  StartRunInput,
  StartRunResponse,
} from "../contracts/specgraph";
import { relationshipReason } from "../analysis/deterministic";
import { expireStaleAnalysisRuns } from "../analysis/run-lifecycle";
import {
  ensureSourceGroup,
  removeEmptySourceGroups,
} from "../providers/source-groups";
import { ApiError } from "./http";

const changedGraphNodes = alias(graphNodes, "changed_graph_nodes");
const changedArtifactRecords = alias(artifacts, "changed_artifact_records");
const evidenceGraphNodes = alias(graphNodes, "evidence_graph_nodes");
const evidenceArtifactRecords = alias(artifacts, "evidence_artifact_records");

function normalizeTimestamp(value: string | null): string | null {
  if (!value) return null;
  const withTimezone = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(withTimezone);
  return Number.isNaN(date.valueOf()) ? value : date.toISOString();
}

function artifactKind(
  value: "code" | "config" | "test" | "markdown" | "openapi" | "confluence" | null,
): ArtifactKind {
  switch (value) {
    case "test":
      return "Test";
    case "config":
      return "Config";
    case "markdown":
      return "Markdown";
    case "openapi":
      return "OpenAPI";
    case "confluence":
      return "Confluence";
    default:
      return "Code";
  }
}

function parseChangedArtifacts(value: string): ChangedArtifact[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is ChangedArtifact => {
      if (!item || typeof item !== "object") return false;
      const record = item as Partial<ChangedArtifact>;
      const validChangeType =
        record.changeType === undefined ||
        record.changeType === "added" ||
        record.changeType === "modified" ||
        record.changeType === "deleted" ||
        record.changeType === "renamed";
      return (
        typeof record.id === "string" &&
        typeof record.name === "string" &&
        typeof record.kind === "string" &&
        typeof record.location === "string" &&
        (record.externalUrl === null || typeof record.externalUrl === "string") &&
        validChangeType
      );
    });
  } catch {
    return [];
  }
}

async function listChangedArtifactsForRuns(
  runIds: string[],
  db: SpecGraphDb,
): Promise<Map<string, ChangedArtifact[]>> {
  const byRun = new Map(runIds.map((runId) => [runId, [] as ChangedArtifact[]]));
  if (!runIds.length) return byRun;

  const rows = await db
    .select({
      runId: findings.runId,
      artifactId: artifacts.id,
      kind: artifacts.kind,
      title: artifacts.title,
      path: artifacts.path,
      canonicalUrl: artifacts.canonicalUrl,
    })
    .from(findings)
    .innerJoin(graphNodes, eq(findings.changedNodeId, graphNodes.id))
    .innerJoin(artifacts, eq(graphNodes.artifactId, artifacts.id))
    .where(inArray(findings.runId, runIds));
  const seenByRun = new Map<string, Set<string>>();
  for (const row of rows) {
    const seen = seenByRun.get(row.runId) || new Set<string>();
    if (seen.has(row.artifactId)) continue;
    seen.add(row.artifactId);
    seenByRun.set(row.runId, seen);
    byRun.get(row.runId)?.push({
      id: row.artifactId,
      name: row.title,
      kind: artifactKind(row.kind),
      location: row.path,
      externalUrl: row.canonicalUrl,
    });
  }
  return byRun;
}

function lineUrl(
  kind: "code" | "config" | "test" | "markdown" | "openapi" | "confluence" | null,
  url: string | null,
  startLine: number,
): string | null {
  if (!url || kind === "confluence") return url;
  return `${url.split("#L")[0]}#L${startLine}-L${startLine + 3}`;
}

type ReviewedAffectedArtifact = AffectedArtifact & {
  reviewStatus: "open" | "resolved" | "dismissed";
};

async function listAffectedArtifactsForRuns(
  runIds: string[],
  db: SpecGraphDb,
): Promise<Map<string, ReviewedAffectedArtifact[]>> {
  const byRun = new Map(runIds.map((runId) => [runId, [] as ReviewedAffectedArtifact[]]));
  if (!runIds.length) return byRun;
  const rows = await db
    .select({
      runId: findings.runId,
      findingId: findings.id,
      findingTitle: findings.title,
      findingSummary: findings.summary,
      findingConfidence: findings.confidence,
      findingOrigin: findings.origin,
      findingProvenance: findings.provenance,
      changedNodeId: findings.changedNodeId,
      reviewStatus: findings.status,
      artifactKind: artifacts.kind,
      artifactTitle: artifacts.title,
      artifactPath: artifacts.path,
      artifactUrl: artifacts.canonicalUrl,
      evidenceLocation: findingEvidence.location,
      evidenceExcerpt: findingEvidence.excerpt,
      evidenceUrl: findingEvidence.sourceUrl,
      changedArtifactKind: changedArtifactRecords.kind,
      changedArtifactId: changedArtifactRecords.id,
      changedArtifactTitle: changedArtifactRecords.title,
      changedArtifactPath: changedArtifactRecords.path,
      changedArtifactUrl: changedArtifactRecords.canonicalUrl,
      relationshipType: relationships.type,
      relationshipFromNodeId: relationships.fromNodeId,
      relationshipEvidence: relationships.evidence,
      relationshipEvidenceStartLine: relationships.evidenceStartLine,
      relationshipEvidenceKind: evidenceArtifactRecords.kind,
      relationshipEvidencePath: evidenceArtifactRecords.path,
      relationshipEvidenceUrl: evidenceArtifactRecords.canonicalUrl,
    })
    .from(findings)
    .leftJoin(graphNodes, eq(findings.affectedNodeId, graphNodes.id))
    .leftJoin(artifacts, eq(graphNodes.artifactId, artifacts.id))
    .leftJoin(changedGraphNodes, eq(findings.changedNodeId, changedGraphNodes.id))
    .leftJoin(
      changedArtifactRecords,
      eq(changedGraphNodes.artifactId, changedArtifactRecords.id),
    )
    .leftJoin(
      relationships,
      or(
        and(
          eq(relationships.fromNodeId, findings.changedNodeId),
          eq(relationships.toNodeId, findings.affectedNodeId),
        ),
        and(
          eq(relationships.fromNodeId, findings.affectedNodeId),
          eq(relationships.toNodeId, findings.changedNodeId),
        ),
      ),
    )
    .leftJoin(evidenceGraphNodes, eq(relationships.fromNodeId, evidenceGraphNodes.id))
    .leftJoin(
      evidenceArtifactRecords,
      eq(evidenceGraphNodes.artifactId, evidenceArtifactRecords.id),
    )
    .leftJoin(findingEvidence, eq(findingEvidence.findingId, findings.id))
    .where(inArray(findings.runId, runIds))
    .orderBy(desc(findings.createdAt));

  const unique = new Set<string>();

  for (const row of rows) {
    const uniqueKey = `${row.runId}:${row.findingId}`;
    if (unique.has(uniqueKey)) continue;
    unique.add(uniqueKey);
    const fallbackEvidenceStartLine = Math.max(1, row.relationshipEvidenceStartLine || 1);
    const reason =
      row.relationshipType &&
      row.relationshipFromNodeId &&
      row.changedNodeId &&
      row.changedArtifactPath &&
      row.changedArtifactKind &&
      row.artifactKind
        ? relationshipReason(
            row.relationshipType,
            row.changedArtifactPath,
            row.changedArtifactKind,
            row.artifactKind,
            row.relationshipFromNodeId === row.changedNodeId,
          )
        : row.findingSummary;
    byRun.get(row.runId)?.push({
      id: row.findingId,
      name: row.artifactTitle || row.findingTitle,
      kind: artifactKind(row.artifactKind),
      location: row.artifactPath || "Source location unavailable",
      changedArtifact: row.changedArtifactPath
        ? {
            id:
              row.changedArtifactId ||
              row.changedNodeId ||
              row.changedArtifactPath,
            name: row.changedArtifactTitle || row.changedArtifactPath,
            kind: artifactKind(row.changedArtifactKind),
            location: row.changedArtifactPath,
            externalUrl: row.changedArtifactUrl,
          }
        : null,
      evidenceLocation:
        row.evidenceLocation ||
        (row.relationshipEvidencePath
          ? `${row.relationshipEvidencePath}:${fallbackEvidenceStartLine}`
          : "Evidence location unavailable"),
      excerpt:
        row.evidenceExcerpt ||
        row.relationshipEvidence ||
        "No source excerpt was recorded.",
      reason,
      confidence: row.findingConfidence,
      origin: row.findingOrigin,
      provenance: row.findingProvenance,
      externalUrl: row.artifactUrl,
      evidenceUrl:
        row.evidenceUrl ||
        lineUrl(
            row.relationshipEvidenceKind,
            row.relationshipEvidenceUrl,
            fallbackEvidenceStartLine,
          ),
      reviewStatus: row.reviewStatus,
    });
  }

  return byRun;
}

function toAffectedArtifact(
  item: AffectedArtifact & {
    reviewStatus: "open" | "resolved" | "dismissed";
  },
): AffectedArtifact {
  return {
    id: item.id,
    name: item.name,
    kind: item.kind,
    location: item.location,
    changedArtifact: item.changedArtifact,
    evidenceLocation: item.evidenceLocation,
    excerpt: item.excerpt,
    reason: item.reason,
    confidence: item.confidence,
    origin: item.origin,
    provenance: item.provenance,
    externalUrl: item.externalUrl,
    evidenceUrl: item.evidenceUrl,
    reviewStatus: item.reviewStatus,
  };
}

function reviewedChangeStatus(
  affected: Array<
    AffectedArtifact & { reviewStatus: "open" | "resolved" | "dismissed" }
  >,
): ChangeItem["status"] {
  if (affected.some((item) => item.reviewStatus === "open")) return "open";
  if (affected.length && affected.every((item) => item.reviewStatus === "resolved")) {
    return "resolved";
  }
  if (affected.length && affected.every((item) => item.reviewStatus === "dismissed")) {
    return "dismissed";
  }
  return "reviewed";
}

export async function listChanges(
  workspaceId: string,
  filter: ChangeFilter,
  db: SpecGraphDb = getDb(),
): Promise<ChangeListResponse> {
  const rows = await db
    .select({
      runId: analysisRuns.id,
      runStatus: analysisRuns.status,
      runCreatedAt: analysisRuns.createdAt,
      runCompletedAt: analysisRuns.completedAt,
      runRequestedByUserId: analysisRuns.requestedByUserId,
      changeId: changeEvents.id,
      title: changeEvents.title,
      sourceLabel: changeEvents.sourceLabel,
      sourceUrl: changeEvents.sourceUrl,
      occurredAt: changeEvents.occurredAt,
      summary: changeEvents.summary,
      changedArtifactsJson: changeEvents.changedArtifactsJson,
      evidenceSummary: changeEvents.evidenceSummary,
    })
    .from(analysisRuns)
    .innerJoin(changeEvents, eq(analysisRuns.changeEventId, changeEvents.id))
    .where(eq(analysisRuns.workspaceId, workspaceId))
    .orderBy(desc(changeEvents.occurredAt), desc(analysisRuns.createdAt))
    .limit(50);

  const runIds = rows.map((row) => row.runId);
  const fallbackRunIds = rows
    .filter((row) => !parseChangedArtifacts(row.changedArtifactsJson).length)
    .map((row) => row.runId);
  const [affectedByRun, changedArtifactsByRun] = await Promise.all([
    listAffectedArtifactsForRuns(runIds, db),
    listChangedArtifactsForRuns(fallbackRunIds, db),
  ]);

  const items = rows.map((row): ChangeItem => {
      const affected = affectedByRun.get(row.runId) || [];
      const storedChangedArtifacts = parseChangedArtifacts(row.changedArtifactsJson);
      const changedArtifacts = (
        storedChangedArtifacts.length
          ? storedChangedArtifacts
          : changedArtifactsByRun.get(row.runId) || []
      ).map((artifact) => ({
        ...artifact,
        externalUrl: artifact.externalUrl || row.sourceUrl,
      }));
      const affectedWithChangedSource = affected.map((item) =>
        item.changedArtifact || changedArtifacts.length !== 1
          ? item
          : { ...item, changedArtifact: changedArtifacts[0] },
      );
      const status =
        row.runStatus === "queued"
          ? row.runRequestedByUserId
            ? "processing"
            : "scheduled"
          : row.runStatus === "running"
            ? "processing"
            : reviewedChangeStatus(affected);

      return {
        id: row.changeId,
        runId: row.runId,
        title: row.title,
        source: row.sourceLabel,
        sourceUrl: row.sourceUrl,
        occurredAt: normalizeTimestamp(row.occurredAt) || row.occurredAt,
        status,
        affected: affected.length,
        summary: row.summary,
        evidence: row.evidenceSummary,
        changedArtifacts,
        artifacts: affectedWithChangedSource.map(toAffectedArtifact),
      };
    });

  const openCount = items.filter((item) => item.status === "open").length;
  const scheduledCount = items.filter((item) => item.status === "scheduled").length;
  const visibleItems = filter === "open" ? items.filter((item) => item.status === "open") : items;
  const lastCheckedAt = rows
    .map((row) => normalizeTimestamp(row.runCompletedAt))
    .find(Boolean) || null;

  return {
    items: visibleItems,
    counts: { open: openCount, scheduled: scheduledCount, total: items.length },
    lastCheckedAt,
  };
}

export async function getChange(
  workspaceId: string,
  changeId: string,
  db: SpecGraphDb = getDb(),
): Promise<ChangeItem> {
  const changes = await listChanges(workspaceId, "all", db);
  const item = changes.items.find((change) => change.id === changeId);
  if (!item) throw new ApiError(404, "CHANGE_NOT_FOUND", "That change was not found.");
  return item;
}

export async function updateChange(
  workspaceId: string,
  changeId: string,
  userId: string,
  action: FindingAction,
  db: SpecGraphDb = getDb(),
): Promise<ChangeItem> {
  const runRows = await db
    .select({ id: analysisRuns.id })
    .from(analysisRuns)
    .where(
      and(
        eq(analysisRuns.workspaceId, workspaceId),
        eq(analysisRuns.changeEventId, changeId),
      ),
    );

  if (!runRows.length) {
    throw new ApiError(404, "CHANGE_NOT_FOUND", "That change was not found.");
  }

  const findingRows = await db
    .select({ id: findings.id, status: findings.status })
    .from(findings)
    .where(inArray(findings.runId, runRows.map((run) => run.id)));

  if (!findingRows.length) {
    throw new ApiError(409, "NO_FINDINGS", "This change has no findings to update.");
  }

  const nextStatus =
    action === "dismiss" ? "dismissed" : action === "resolve" ? "resolved" : "open";
  const now = new Date().toISOString();

  const applicableFindings = findingRows.filter((finding) =>
    action === "reopen" ? finding.status !== "open" : finding.status === "open",
  );

  for (const finding of applicableFindings) {
    await db
      .update(findings)
      .set({ status: nextStatus, updatedAt: now })
      .where(eq(findings.id, finding.id));
    await db.insert(findingActions).values({
      id: `act_${crypto.randomUUID()}`,
      findingId: finding.id,
      userId,
      action,
      createdAt: now,
    });
  }

  return getChange(workspaceId, changeId, db);
}

export async function updateFinding(
  workspaceId: string,
  changeId: string,
  findingId: string,
  userId: string,
  action: FindingAction,
  db: SpecGraphDb = getDb(),
): Promise<ChangeItem> {
  const [finding] = await db
    .select({ id: findings.id, status: findings.status })
    .from(findings)
    .innerJoin(analysisRuns, eq(findings.runId, analysisRuns.id))
    .where(
      and(
        eq(findings.id, findingId),
        eq(analysisRuns.workspaceId, workspaceId),
        eq(analysisRuns.changeEventId, changeId),
      ),
    )
    .limit(1);

  if (!finding) {
    throw new ApiError(
      404,
      "FINDING_NOT_FOUND",
      "That suggestion was not found for this change.",
    );
  }

  const nextStatus =
    action === "dismiss" ? "dismissed" : action === "resolve" ? "resolved" : "open";
  if (finding.status !== nextStatus) {
    const now = new Date().toISOString();
    await db
      .update(findings)
      .set({ status: nextStatus, updatedAt: now })
      .where(eq(findings.id, finding.id));
    await db.insert(findingActions).values({
      id: `act_${crypto.randomUUID()}`,
      findingId: finding.id,
      userId,
      action,
      createdAt: now,
    });
  }

  return getChange(workspaceId, changeId, db);
}

async function findingCount(runId: string, db: SpecGraphDb): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(findings)
    .where(eq(findings.runId, runId));
  return row?.value ?? 0;
}

function toRunItem(
  row: typeof analysisRuns.$inferSelect,
  findingsCount: number,
): RunItem {
  return {
    id: row.id,
    title: row.title,
    trigger: row.trigger,
    execution: row.requestedByUserId ? "immediate" : "daily",
    target: row.target,
    status: row.status,
    progress: row.progress,
    createdAt: normalizeTimestamp(row.createdAt) || row.createdAt,
    completedAt: normalizeTimestamp(row.completedAt),
    findingsCount,
    errorMessage: row.errorMessage,
  };
}

export async function listRuns(
  workspaceId: string,
  db: SpecGraphDb = getDb(),
): Promise<RunListResponse> {
  // Polling this endpoint also reconciles a worker that disappeared before it
  // could report failure, so the UI never displays "Analyzing" indefinitely.
  await expireStaleAnalysisRuns({ workspaceId }, db);
  const rows = await db
    .select()
    .from(analysisRuns)
    .where(eq(analysisRuns.workspaceId, workspaceId))
    .orderBy(desc(analysisRuns.createdAt))
    .limit(50);

  const runIds = rows.map((row) => row.id);
  const countRows = runIds.length
    ? await db
        .select({ runId: findings.runId, value: count() })
        .from(findings)
        .where(inArray(findings.runId, runIds))
        .groupBy(findings.runId)
    : [];
  const countsByRun = new Map(countRows.map((row) => [row.runId, row.value]));

  return {
    items: rows.map((row) => toRunItem(row, countsByRun.get(row.id) || 0)),
  };
}

export async function getRun(
  workspaceId: string,
  runId: string,
  db: SpecGraphDb = getDb(),
): Promise<RunItem> {
  const [row] = await db
    .select()
    .from(analysisRuns)
    .where(and(eq(analysisRuns.workspaceId, workspaceId), eq(analysisRuns.id, runId)))
    .limit(1);

  if (!row) throw new ApiError(404, "RUN_NOT_FOUND", "That analysis run was not found.");
  return toRunItem(row, await findingCount(row.id, db));
}

export async function retryFailedRun(
  workspaceId: string,
  runId: string,
  userId: string,
  db: SpecGraphDb = getDb(),
): Promise<RetryRunResponse> {
  const now = new Date().toISOString();
  const [run] = await db
    .update(analysisRuns)
    .set({
      requestedByUserId: userId,
      status: "queued",
      progress: 0,
      maxAttempts: sql`${analysisRuns.attempts} + 3`,
      errorCode: null,
      errorMessage: null,
      workflowRunId: null,
      startedAt: null,
      completedAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(analysisRuns.id, runId),
        eq(analysisRuns.workspaceId, workspaceId),
        eq(analysisRuns.status, "failed"),
      ),
    )
    .returning();

  if (!run) {
    const [existing] = await db
      .select({ status: analysisRuns.status })
      .from(analysisRuns)
      .where(
        and(
          eq(analysisRuns.id, runId),
          eq(analysisRuns.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!existing) {
      throw new ApiError(404, "RUN_NOT_FOUND", "That analysis run was not found.");
    }
    throw new ApiError(
      409,
      "RUN_NOT_FAILED",
      "Only a failed analysis can be retried.",
    );
  }

  return { run: toRunItem(run, await findingCount(run.id, db)) };
}

export async function createManualRun(
  workspaceId: string,
  userId: string,
  input: StartRunInput,
  db: SpecGraphDb = getDb(),
): Promise<StartRunResponse> {
  const sourceRows = await db
    .select()
    .from(sources)
    .where(
      input.sourceId
        ? and(
            eq(sources.workspaceId, workspaceId),
            eq(sources.id, input.sourceId),
            eq(sources.status, "connected"),
          )
        : and(eq(sources.workspaceId, workspaceId), eq(sources.status, "connected")),
    )
    .orderBy(desc(sources.lastSyncedAt), desc(sources.createdAt))
    .limit(1);
  const source = sourceRows[0];

  if (!source) {
    throw new ApiError(
      409,
      "SOURCE_REQUIRED",
      "Connect a source before starting an analysis.",
    );
  }

  const target = input.target.trim();
  if (!target) throw new ApiError(400, "TARGET_REQUIRED", "Enter something to analyze.");
  if (target.length > 300) {
    throw new ApiError(400, "TARGET_TOO_LONG", "The analysis target is too long.");
  }

  const now = new Date().toISOString();
  const run = {
    id: `run_${crypto.randomUUID()}`,
    workspaceId,
    sourceId: source.id,
    requestedByUserId: userId,
    trigger: "manual" as const,
    title: `Checking ${target}`,
    target,
    status: "queued" as const,
    progress: 0,
    attempts: 0,
    maxAttempts: 3,
    createdAt: now,
    updatedAt: now,
  };

  await db.insert(analysisRuns).values(run);
  return {
    run: toRunItem(
      {
        ...run,
        changeEventId: null,
        errorCode: null,
        errorMessage: null,
        workflowRunId: null,
        startedAt: null,
        completedAt: null,
      },
      0,
    ),
  };
}

export async function listSources(
  workspaceId: string,
  db: SpecGraphDb = getDb(),
): Promise<SourceListResponse> {
  const rows = await db
    .select()
    .from(sources)
    .where(eq(sources.workspaceId, workspaceId))
    .orderBy(desc(sources.createdAt));

  const sourceIds = rows.map((row) => row.id);
  const artifactCountRows = sourceIds.length
    ? await db
        .select({
          sourceId: artifacts.sourceId,
          all: count(),
          code: sql<number>`count(*) filter (where ${artifacts.kind} in ('code', 'config', 'test'))`.mapWith(Number),
          documentation: sql<number>`count(*) filter (where ${artifacts.kind} in ('markdown', 'openapi', 'confluence'))`.mapWith(Number),
        })
        .from(artifacts)
        .where(inArray(artifacts.sourceId, sourceIds))
        .groupBy(artifacts.sourceId)
    : [];
  const countsBySource = new Map(
    artifactCountRows.map((row) => [row.sourceId, row]),
  );

  const items = rows.map((row): SourceItem => {
        const sourceCounts = countsBySource.get(row.id);
        return {
          id: row.id,
          provider: row.provider,
          name: row.name,
          detail: row.detail,
          status: row.status,
          lastError: row.lastError,
          lastSyncedAt: normalizeTimestamp(row.lastSyncedAt),
          artifactCount: sourceCounts?.all ?? 0,
          codeArtifactCount: sourceCounts?.code ?? 0,
          documentationArtifactCount: sourceCounts?.documentation ?? 0,
          canonicalUrl: row.canonicalUrl,
        };
      });
  let memberships = await db
    .select({
      groupId: sourceGroupMembers.groupId,
      sourceId: sourceGroupMembers.sourceId,
      groupCreatedAt: sourceGroups.createdAt,
      memberCreatedAt: sourceGroupMembers.createdAt,
    })
    .from(sourceGroupMembers)
    .innerJoin(sourceGroups, eq(sourceGroupMembers.groupId, sourceGroups.id))
    .where(eq(sourceGroupMembers.workspaceId, workspaceId))
    .orderBy(desc(sourceGroups.createdAt), sourceGroupMembers.createdAt);

  const groupedSourceIds = new Set(memberships.map((item) => item.sourceId));
  const orphanedSources = items.filter((item) => !groupedSourceIds.has(item.id));
  if (orphanedSources.length) {
    await Promise.all(
      orphanedSources.map((source) =>
        ensureSourceGroup(workspaceId, source.id, null, db),
      ),
    );
    memberships = await db
      .select({
        groupId: sourceGroupMembers.groupId,
        sourceId: sourceGroupMembers.sourceId,
        groupCreatedAt: sourceGroups.createdAt,
        memberCreatedAt: sourceGroupMembers.createdAt,
      })
      .from(sourceGroupMembers)
      .innerJoin(sourceGroups, eq(sourceGroupMembers.groupId, sourceGroups.id))
      .where(eq(sourceGroupMembers.workspaceId, workspaceId))
      .orderBy(desc(sourceGroups.createdAt), sourceGroupMembers.createdAt);
  }

  const byId = new Map(items.map((item) => [item.id, item]));
  const groupsById = new Map<string, SourceGroup>();
  for (const membership of memberships) {
    const source = byId.get(membership.sourceId);
    if (!source) continue;
    const group = groupsById.get(membership.groupId) || {
      id: membership.groupId,
      sources: [],
    };
    group.sources.push(source);
    groupsById.set(membership.groupId, group);
  }
  const groups = [...groupsById.values()];
  return { items, groups };
}

export async function getSource(
  workspaceId: string,
  sourceId: string,
  db: SpecGraphDb = getDb(),
): Promise<SourceItem> {
  const result = await listSources(workspaceId, db);
  const source = result.items.find((item) => item.id === sourceId);
  if (!source) throw new ApiError(404, "SOURCE_NOT_FOUND", "That source was not found.");
  return source;
}

export async function removeSource(
  workspaceId: string,
  sourceId: string,
  db: SpecGraphDb = getDb(),
): Promise<{ removedSourceId: string }> {
  const [source] = await db
    .select({ id: sources.id })
    .from(sources)
    .where(and(eq(sources.id, sourceId), eq(sources.workspaceId, workspaceId)))
    .limit(1);

  if (!source) {
    throw new ApiError(404, "SOURCE_NOT_FOUND", "That source was not found.");
  }

  // Change events intentionally outlive a disconnected source so the review
  // history remains understandable. Their private before/after snippets must
  // not: redact indexed content before the source foreign key becomes null.
  await db
    .update(changeEvents)
    .set({ analysisScopeJson: "[]" })
    .where(
      and(
        eq(changeEvents.workspaceId, workspaceId),
        eq(changeEvents.sourceId, sourceId),
      ),
    );
  await db
    .delete(sources)
    .where(and(eq(sources.id, sourceId), eq(sources.workspaceId, workspaceId)));
  await removeEmptySourceGroups(workspaceId, db);

  return { removedSourceId: source.id };
}
