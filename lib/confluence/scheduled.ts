import { and, eq, inArray } from "drizzle-orm";
import { getDb, type SpecGraphDb } from "../../db";
import {
  analysisRuns,
  artifactAnalysisCursors,
  artifacts,
  changeEvents,
  graphNodes,
  sources,
} from "../../db/schema";
import {
  beginRunAttempt,
  completeRunAttempt,
  failRunAttempt,
} from "../analysis/run-lifecycle";
import { persistDeterministicFindings } from "../analysis/deterministic";
import { sha256Hex } from "../github/crypto";
import { rebuildCrossSourceRelationships } from "../providers/cross-source-relationships";
import type { ConfluenceSourceProvider } from "./client";
import { syncConfluenceSource } from "./ingestion";

type IndexedConfluencePage = {
  id: string;
  title: string;
  path: string;
  canonicalUrl: string | null;
  currentRevision: string | null;
};

export type ScheduledConfluenceResult = {
  changedPages: number;
  runId: string | null;
};

async function indexedPages(
  sourceId: string,
  db: SpecGraphDb,
): Promise<IndexedConfluencePage[]> {
  return db
    .select({
      id: artifacts.id,
      title: artifacts.title,
      path: artifacts.path,
      canonicalUrl: artifacts.canonicalUrl,
      currentRevision: artifacts.currentRevision,
    })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.sourceId, sourceId),
        eq(artifacts.kind, "confluence"),
      ),
    );
}

async function baselineExistingPages(
  pages: IndexedConfluencePage[],
  db: SpecGraphDb,
): Promise<void> {
  const now = new Date().toISOString();
  for (const page of pages) {
    if (!page.currentRevision) continue;
    await db
      .insert(artifactAnalysisCursors)
      .values({
        artifactId: page.id,
        revision: page.currentRevision,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: artifactAnalysisCursors.artifactId });
  }
}

async function pendingPages(
  sourceId: string,
  db: SpecGraphDb,
): Promise<Array<IndexedConfluencePage & { previousRevision: string | null }>> {
  const pages = await indexedPages(sourceId, db);
  if (!pages.length) return [];
  const cursors = await db
    .select()
    .from(artifactAnalysisCursors)
    .where(inArray(artifactAnalysisCursors.artifactId, pages.map((page) => page.id)));
  const revisionByArtifact = new Map(
    cursors.map((cursor) => [cursor.artifactId, cursor.revision]),
  );
  return pages.flatMap((page) => {
    if (!page.currentRevision) return [];
    const previousRevision = revisionByArtifact.get(page.id) || null;
    return previousRevision === page.currentRevision
      ? []
      : [{ ...page, previousRevision }];
  });
}

async function advanceCursors(
  pages: Array<IndexedConfluencePage & { previousRevision: string | null }>,
  db: SpecGraphDb,
): Promise<void> {
  const now = new Date().toISOString();
  for (const page of pages) {
    if (!page.currentRevision) continue;
    await db
      .insert(artifactAnalysisCursors)
      .values({
        artifactId: page.id,
        revision: page.currentRevision,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: artifactAnalysisCursors.artifactId,
        set: { revision: page.currentRevision, updatedAt: now },
      });
  }
}

export async function analyzePendingConfluenceChanges(
  workspaceId: string,
  sourceId: string,
  db: SpecGraphDb = getDb(),
): Promise<ScheduledConfluenceResult> {
  const [source] = await db
    .select({ id: sources.id, name: sources.name, provider: sources.provider })
    .from(sources)
    .where(
      and(
        eq(sources.id, sourceId),
        eq(sources.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  if (!source || source.provider !== "confluence") {
    throw new Error("The scheduled Confluence source no longer exists.");
  }

  const changedPages = await pendingPages(sourceId, db);
  if (!changedPages.length) return { changedPages: 0, runId: null };

  const fingerprint = changedPages
    .map((page) => `${page.id}:${page.currentRevision}`)
    .sort()
    .join("|");
  const idSuffix = (await sha256Hex(`confluence:${sourceId}:${fingerprint}`)).slice(0, 32);
  const changeId = `chg_cnf_${idSuffix}`;
  const runId = `run_cnf_${idSuffix}`;
  const now = new Date().toISOString();
  const onePage = changedPages.length === 1 ? changedPages[0] : null;
  const title = onePage
    ? `${onePage.title} changed`
    : `${changedPages.length} Confluence pages changed`;

  await db
    .insert(changeEvents)
    .values({
      id: changeId,
      workspaceId,
      sourceId,
      trigger: "scheduled",
      title,
      summary: `${changedPages.length} Confluence ${changedPages.length === 1 ? "page has" : "pages have"} changed since the last check.`,
      changedArtifactsJson: JSON.stringify(
        changedPages.map((page) => ({
          id: page.id,
          name: page.title,
          kind: "Confluence",
          location: page.path,
          externalUrl: page.canonicalUrl,
        })),
      ),
      evidenceSummary:
        "SpecGraph checked linked code, tests, and other documentation without changing any connected source.",
      sourceLabel: `Confluence / ${source.name}`,
      sourceUrl: onePage?.canonicalUrl || null,
      beforeRevision: onePage?.previousRevision || null,
      afterRevision: onePage?.currentRevision || idSuffix,
      actor: null,
      occurredAt: now,
      createdAt: now,
    })
    .onConflictDoNothing({ target: changeEvents.id });
  await db
    .insert(analysisRuns)
    .values({
      id: runId,
      workspaceId,
      sourceId,
      changeEventId: changeId,
      requestedByUserId: null,
      trigger: "scheduled",
      title,
      target: onePage?.title || `${changedPages.length} changed pages`,
      status: "queued",
      progress: 0,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: analysisRuns.id });

  const [run] = await db
    .select({ status: analysisRuns.status })
    .from(analysisRuns)
    .where(eq(analysisRuns.id, runId))
    .limit(1);
  if (run?.status === "succeeded") {
    await advanceCursors(changedPages, db);
    return { changedPages: changedPages.length, runId };
  }
  if (run?.status === "running") {
    return { changedPages: changedPages.length, runId };
  }
  let attemptId: string | null = null;
  try {
    attemptId = await beginRunAttempt(runId, "scheduled_confluence", db);
    if (!attemptId) return { changedPages: changedPages.length, runId };
    const changedNodes = await db
      .select({ id: graphNodes.id, path: artifacts.path })
      .from(graphNodes)
      .innerJoin(artifacts, eq(graphNodes.artifactId, artifacts.id))
      .where(inArray(artifacts.id, changedPages.map((page) => page.id)));
    await persistDeterministicFindings(workspaceId, runId, changedNodes, db);
    await completeRunAttempt(runId, attemptId, db);
    await advanceCursors(changedPages, db);
    return { changedPages: changedPages.length, runId };
  } catch (error) {
    await failRunAttempt(
      runId,
      attemptId,
      error,
      "CONFLUENCE_SCHEDULED_ANALYSIS_FAILED",
      "Scheduled Confluence analysis failed.",
      db,
    );
    throw error;
  }
}

export async function checkConfluenceSource(
  workspaceId: string,
  sourceId: string,
  encryptionKey: string,
  client: ConfluenceSourceProvider,
  db: SpecGraphDb = getDb(),
): Promise<ScheduledConfluenceResult> {
  const before = await indexedPages(sourceId, db);
  await baselineExistingPages(before, db);
  await syncConfluenceSource(workspaceId, sourceId, encryptionKey, client, db);
  await rebuildCrossSourceRelationships(workspaceId, sourceId, db);

  if (!before.length) {
    await baselineExistingPages(await indexedPages(sourceId, db), db);
    return { changedPages: 0, runId: null };
  }
  return analyzePendingConfluenceChanges(workspaceId, sourceId, db);
}
