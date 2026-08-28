import { and, count, desc, eq, inArray, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb, type SpecGraphDb } from "../../db";
import {
  analysisRuns,
  artifacts,
  artifactVersions,
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
  SourceItem,
  SourceGroup,
  SourceListResponse,
  StartRunInput,
  StartRunResponse,
} from "../contracts/specgraph";
import { relationshipReason } from "../analysis/deterministic";
import {
  ensureSourceGroup,
  removeEmptySourceGroups,
} from "../providers/source-groups";
import { ApiError } from "./http";

const changedGraphNodes = alias(graphNodes, "changed_graph_nodes");
const changedArtifactRecords = alias(artifacts, "changed_artifact_records");
const evidenceGraphNodes = alias(graphNodes, "evidence_graph_nodes");
const evidenceArtifactRecords = alias(artifacts, "evidence_artifact_records");
const evidenceVersions = alias(artifactVersions, "evidence_versions");

function normalizeTimestamp(value: string | null): string | null {
  if (!value) return null;
  const withTimezone = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(withTimezone);
  return Number.isNaN(date.valueOf()) ? value : date.toISOString();
}

function artifactKind(
  value: "code" | "test" | "markdown" | "openapi" | "confluence" | null,
): ArtifactKind {
  switch (value) {
    case "test":
      return "Test";
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
      return (
        typeof record.id === "string" &&
        typeof record.name === "string" &&
        typeof record.kind === "string" &&
        typeof record.location === "string" &&
        (record.externalUrl === null || typeof record.externalUrl === "string")
      );
    });
  } catch {
    return [];
  }
}

async function listChangedArtifacts(
  runId: string,
  storedValue: string,
  changeUrl: string | null,
  db: SpecGraphDb,
): Promise<ChangedArtifact[]> {
  const stored = parseChangedArtifacts(storedValue);
  if (stored.length) return stored;

  const rows = await db
    .select({
      artifactId: artifacts.id,
      kind: artifacts.kind,
      title: artifacts.title,
      path: artifacts.path,
      canonicalUrl: artifacts.canonicalUrl,
    })
    .from(findings)
    .innerJoin(graphNodes, eq(findings.changedNodeId, graphNodes.id))
    .innerJoin(artifacts, eq(graphNodes.artifactId, artifacts.id))
    .where(eq(findings.runId, runId));
  const unique = new Map<string, ChangedArtifact>();
  for (const row of rows) {
    unique.set(row.artifactId, {
      id: row.artifactId,
      name: row.title,
      kind: artifactKind(row.kind),
      location: row.path,
      externalUrl: changeUrl || row.canonicalUrl,
    });
  }
  return [...unique.values()];
}

function referencedExcerpt(
  content: string,
  targetPath: string,
  storedEvidence: string,
  storedStartLine: number | null,
): { excerpt: string; startLine: number } {
  const lines = content.split("\n");
  const filename = targetPath.split("/").at(-1) || targetPath;
  let index = lines.findIndex((line) => line.includes(targetPath));
  if (index < 0) index = lines.findIndex((line) => line.includes(filename));
  if (index < 0 && storedStartLine) index = storedStartLine - 1;
  if (index < 0) {
    return { excerpt: storedEvidence, startLine: 1 };
  }
  return {
    excerpt: lines.slice(index, index + 4).join("\n").trim() || storedEvidence,
    startLine: index + 1,
  };
}

function lineUrl(
  kind: "code" | "test" | "markdown" | "openapi" | "confluence" | null,
  url: string | null,
  startLine: number,
): string | null {
  if (!url || kind === "confluence") return url;
  return `${url.split("#L")[0]}#L${startLine}-L${startLine + 3}`;
}

async function listAffectedArtifacts(
  runId: string,
  db: SpecGraphDb,
): Promise<Array<AffectedArtifact & { reviewStatus: "open" | "resolved" | "dismissed" }>> {
  const rows = await db
    .select({
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
      relationshipEvidenceContent: evidenceVersions.extractedText,
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
    .leftJoin(
      evidenceVersions,
      and(
        eq(evidenceVersions.artifactId, evidenceArtifactRecords.id),
        eq(evidenceVersions.revision, evidenceArtifactRecords.currentRevision),
      ),
    )
    .leftJoin(findingEvidence, eq(findingEvidence.findingId, findings.id))
    .where(eq(findings.runId, runId))
    .orderBy(desc(findings.createdAt));

  const unique = new Map<
    string,
    AffectedArtifact & { reviewStatus: "open" | "resolved" | "dismissed" }
  >();

  for (const row of rows) {
    if (unique.has(row.findingId)) continue;
    const reconstructEvidence = Boolean(
      row.relationshipEvidencePath &&
        row.evidenceLocation &&
        !row.evidenceLocation.startsWith(`${row.relationshipEvidencePath}:`),
    );
    const targetPath =
      row.relationshipFromNodeId === row.changedNodeId
        ? row.artifactPath
        : row.changedArtifactPath;
    const reconstructed =
      reconstructEvidence && row.relationshipEvidenceContent && targetPath
        ? referencedExcerpt(
            row.relationshipEvidenceContent,
            targetPath,
            row.relationshipEvidence || row.evidenceExcerpt || "",
            row.relationshipEvidenceStartLine,
          )
        : null;
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
    unique.set(row.findingId, {
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
      evidenceLocation: reconstructed
        ? `${row.relationshipEvidencePath}:${reconstructed.startLine}`
        : row.evidenceLocation || "Evidence location unavailable",
      excerpt:
        reconstructed?.excerpt ||
        row.evidenceExcerpt ||
        "No source excerpt was recorded.",
      reason,
      confidence: row.findingConfidence,
      origin: row.findingOrigin,
      provenance: row.findingProvenance,
      externalUrl: row.artifactUrl,
      evidenceUrl: reconstructed
        ? lineUrl(
            row.relationshipEvidenceKind,
            row.relationshipEvidenceUrl,
            reconstructed.startLine,
          )
        : row.evidenceUrl,
      reviewStatus: row.reviewStatus,
    });
  }

  return [...unique.values()];
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

  const items = await Promise.all(
    rows.map(async (row): Promise<ChangeItem> => {
      const affected = await listAffectedArtifacts(row.runId, db);
      const changedArtifacts = await listChangedArtifacts(
        row.runId,
        row.changedArtifactsJson,
        row.sourceUrl,
        db,
      );
      const affectedWithChangedSource = affected.map((item) =>
        item.changedArtifact || changedArtifacts.length !== 1
          ? item
          : { ...item, changedArtifact: changedArtifacts[0] },
      );
      const status =
        row.runStatus === "queued" || row.runStatus === "running"
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
    }),
  );

  const openCount = items.filter((item) => item.status === "open").length;
  const visibleItems = filter === "open" ? items.filter((item) => item.status === "open") : items;
  const lastCheckedAt = rows
    .map((row) => normalizeTimestamp(row.runCompletedAt || row.runCreatedAt))
    .find(Boolean) || null;

  return {
    items: visibleItems,
    counts: { open: openCount, total: items.length },
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
  const rows = await db
    .select()
    .from(analysisRuns)
    .where(eq(analysisRuns.workspaceId, workspaceId))
    .orderBy(desc(analysisRuns.createdAt))
    .limit(50);

  return {
    items: await Promise.all(
      rows.map(async (row) => toRunItem(row, await findingCount(row.id, db))),
    ),
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

  const items = await Promise.all(
      rows.map(async (row): Promise<SourceItem> => {
        const [allArtifacts, codeArtifacts, documentationArtifacts] = await Promise.all([
          db
            .select({ value: count() })
            .from(artifacts)
            .where(eq(artifacts.sourceId, row.id)),
          db
            .select({ value: count() })
            .from(artifacts)
            .where(
              and(
                eq(artifacts.sourceId, row.id),
                inArray(artifacts.kind, ["code", "test"]),
              ),
            ),
          db
            .select({ value: count() })
            .from(artifacts)
            .where(
              and(
                eq(artifacts.sourceId, row.id),
                inArray(artifacts.kind, ["markdown", "openapi", "confluence"]),
              ),
            ),
        ]);

        return {
          id: row.id,
          provider: row.provider,
          name: row.name,
          detail: row.detail,
          status: row.status,
          lastSyncedAt: normalizeTimestamp(row.lastSyncedAt),
          artifactCount: allArtifacts[0]?.value ?? 0,
          codeArtifactCount: codeArtifacts[0]?.value ?? 0,
          documentationArtifactCount: documentationArtifacts[0]?.value ?? 0,
          canonicalUrl: row.canonicalUrl,
        };
      }),
    );
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

  await db
    .delete(sources)
    .where(and(eq(sources.id, sourceId), eq(sources.workspaceId, workspaceId)));
  await removeEmptySourceGroups(workspaceId, db);

  return { removedSourceId: source.id };
}
