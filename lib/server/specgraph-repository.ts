import { and, count, desc, eq, inArray } from "drizzle-orm";
import { getDb, type SpecGraphDb } from "../../db";
import {
  analysisRuns,
  artifacts,
  changeEvents,
  findingActions,
  findingEvidence,
  findings,
  graphNodes,
  sources,
} from "../../db/schema";
import type {
  AffectedArtifact,
  ArtifactKind,
  ChangeFilter,
  ChangeItem,
  ChangeListResponse,
  FindingAction,
  RunItem,
  RunListResponse,
  SourceItem,
  SourceListResponse,
  StartRunInput,
  StartRunResponse,
} from "../contracts/specgraph";
import { ApiError } from "./http";

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

async function listAffectedArtifacts(
  runId: string,
  db: SpecGraphDb,
): Promise<Array<AffectedArtifact & { reviewStatus: "open" | "resolved" | "dismissed" }>> {
  const rows = await db
    .select({
      findingId: findings.id,
      findingTitle: findings.title,
      findingSummary: findings.summary,
      reviewStatus: findings.status,
      artifactKind: artifacts.kind,
      artifactTitle: artifacts.title,
      artifactPath: artifacts.path,
      artifactUrl: artifacts.canonicalUrl,
      evidenceLocation: findingEvidence.location,
      evidenceExcerpt: findingEvidence.excerpt,
      evidenceUrl: findingEvidence.sourceUrl,
    })
    .from(findings)
    .leftJoin(graphNodes, eq(findings.affectedNodeId, graphNodes.id))
    .leftJoin(artifacts, eq(graphNodes.artifactId, artifacts.id))
    .leftJoin(findingEvidence, eq(findingEvidence.findingId, findings.id))
    .where(eq(findings.runId, runId))
    .orderBy(desc(findings.createdAt));

  const unique = new Map<
    string,
    AffectedArtifact & { reviewStatus: "open" | "resolved" | "dismissed" }
  >();

  for (const row of rows) {
    if (unique.has(row.findingId)) continue;
    unique.set(row.findingId, {
      id: row.findingId,
      name: row.artifactTitle || row.findingTitle,
      kind: artifactKind(row.artifactKind),
      location: row.evidenceLocation || row.artifactPath || "Source location unavailable",
      excerpt: row.evidenceExcerpt || "No source excerpt was recorded.",
      reason: row.findingSummary,
      externalUrl: row.evidenceUrl || row.artifactUrl,
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
    excerpt: item.excerpt,
    reason: item.reason,
    externalUrl: item.externalUrl,
  };
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
      const status =
        row.runStatus === "queued" || row.runStatus === "running"
          ? "processing"
          : affected.some((item) => item.reviewStatus === "open")
            ? "open"
            : "checked";

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
        artifacts: affected.map(toAffectedArtifact),
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
    .select({ id: findings.id })
    .from(findings)
    .where(inArray(findings.runId, runRows.map((run) => run.id)));

  if (!findingRows.length) {
    throw new ApiError(409, "NO_FINDINGS", "This change has no findings to update.");
  }

  const nextStatus =
    action === "dismiss" ? "dismissed" : action === "resolve" ? "resolved" : "open";
  const now = new Date().toISOString();

  for (const finding of findingRows) {
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
  return { run: toRunItem({ ...run, changeEventId: null, errorCode: null, errorMessage: null, startedAt: null, completedAt: null }, 0) };
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

  return {
    items: await Promise.all(
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
        };
      }),
    ),
  };
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
