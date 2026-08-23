import { and, desc, eq } from "drizzle-orm";
import { getDb, type SpecGraphDb } from "../../db";
import {
  analysisRuns,
  artifacts,
  artifactVersions,
  changeEvents,
  graphNodes,
  sources,
} from "../../db/schema";
import type { StartRunInput } from "../contracts/specgraph";
import { GitHubClient } from "../github/client";
import { getGitHubAppConfig } from "../github/config";
import { executeGitHubPullRequestAnalysis } from "../github/analysis";
import { ApiError } from "../server/http";
import { persistDeterministicFindings } from "./deterministic";
import {
  beginRunAttempt,
  completeRunAttempt,
  failRunAttempt,
} from "./run-lifecycle";

type IndexedPage = {
  id: string;
  externalId: string;
  title: string;
  path: string;
  canonicalUrl: string | null;
  currentRevision: string | null;
  updatedAt: string;
};

function chooseConfluencePage(pages: IndexedPage[], target: string): IndexedPage | null {
  const normalized = target.trim().toLowerCase();
  if (!normalized || normalized === "latest") return pages[0] || null;
  const exact = pages.find((page) =>
    page.externalId.toLowerCase() === normalized ||
    page.title.toLowerCase() === normalized ||
    page.path.toLowerCase() === normalized ||
    page.canonicalUrl?.toLowerCase() === normalized,
  );
  if (exact) return exact;
  const partial = pages.filter((page) =>
    page.title.toLowerCase().includes(normalized) ||
    page.path.toLowerCase().includes(normalized),
  );
  return partial.length === 1 ? partial[0] : null;
}

async function executeConfluencePageAnalysis(
  workspaceId: string,
  runId: string,
  input: StartRunInput,
  db: SpecGraphDb,
): Promise<void> {
  let attemptId: string | null = null;
  try {
    attemptId = await beginRunAttempt(runId, "confluence_page", db);
    if (!attemptId) return;
    const [selectedSource] = await db
      .select({ id: sources.id, name: sources.name, provider: sources.provider })
      .from(analysisRuns)
      .innerJoin(sources, eq(analysisRuns.sourceId, sources.id))
      .where(
        and(
          eq(analysisRuns.id, runId),
          eq(analysisRuns.workspaceId, workspaceId),
          eq(sources.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!selectedSource || selectedSource.provider !== "confluence") {
      throw new ApiError(409, "CONFLUENCE_SOURCE_REQUIRED", "Choose connected Confluence documentation.");
    }

    const pages = await db
      .select({
        id: artifacts.id,
        externalId: artifacts.externalId,
        title: artifacts.title,
        path: artifacts.path,
        canonicalUrl: artifacts.canonicalUrl,
        currentRevision: artifacts.currentRevision,
        updatedAt: artifacts.updatedAt,
      })
      .from(artifacts)
      .where(
        and(
          eq(artifacts.sourceId, selectedSource.id),
          eq(artifacts.kind, "confluence"),
        ),
      )
      .orderBy(desc(artifacts.updatedAt));
    const page = chooseConfluencePage(pages, input.target);
    if (!page) {
      throw new ApiError(
        404,
        "CONFLUENCE_PAGE_NOT_FOUND",
        "Enter an indexed Confluence page title, path, URL, or use latest.",
      );
    }

    const versions = await db
      .select()
      .from(artifactVersions)
      .where(eq(artifactVersions.artifactId, page.id))
      .orderBy(desc(artifactVersions.createdAt));
    const current =
      versions.find((version) => version.revision === page.currentRevision) || versions[0];
    const previous = versions.find((version) => version.id !== current?.id);
    const now = new Date().toISOString();
    const changeId = `chg_${crypto.randomUUID()}`;
    await db.insert(changeEvents).values({
      id: changeId,
      workspaceId,
      sourceId: selectedSource.id,
      trigger: "manual",
      title: `Review ${page.title}`,
      summary: previous
        ? `The Confluence page moved from version ${previous.revision} to ${current?.revision || page.currentRevision || "current"}.`
        : "SpecGraph checked the current page against its explicitly connected repository resources.",
      changedArtifactsJson: JSON.stringify([
        {
          id: page.id,
          name: page.title,
          kind: "Confluence",
          location: page.path,
          externalUrl: page.canonicalUrl,
        },
      ]),
      evidenceSummary:
        "SpecGraph checked linked code, tests, and other documentation without changing any connected source.",
      sourceLabel: `Confluence / ${page.title}`,
      sourceUrl: page.canonicalUrl,
      beforeRevision: previous?.revision || null,
      afterRevision: current?.revision || page.currentRevision,
      occurredAt: now,
      createdAt: now,
    });
    await db
      .update(analysisRuns)
      .set({
        changeEventId: changeId,
        title: `Review ${page.title}`,
        target: page.title,
        progress: 45,
        updatedAt: now,
      })
      .where(eq(analysisRuns.id, runId));
    const changedNodes = await db
      .select({ id: graphNodes.id, path: artifacts.path })
      .from(graphNodes)
      .innerJoin(artifacts, eq(graphNodes.artifactId, artifacts.id))
      .where(eq(artifacts.id, page.id));
    await persistDeterministicFindings(workspaceId, runId, changedNodes, db);
    await completeRunAttempt(runId, attemptId, db);
  } catch (error) {
    await failRunAttempt(
      runId,
      attemptId,
      error,
      "CONFLUENCE_ANALYSIS_FAILED",
      "Confluence analysis failed.",
      db,
    );
  }
}

export async function executeManualAnalysis(
  workspaceId: string,
  runId: string,
  input: StartRunInput,
  db: SpecGraphDb = getDb(),
): Promise<void> {
  const [runSource] = await db
    .select({ provider: sources.provider })
    .from(analysisRuns)
    .leftJoin(sources, eq(analysisRuns.sourceId, sources.id))
    .where(
      and(
        eq(analysisRuns.id, runId),
        eq(analysisRuns.workspaceId, workspaceId),
      ),
    )
    .limit(1);

  if (!runSource?.provider) {
    await failRunAttempt(
      runId,
      null,
      new ApiError(409, "SOURCE_REQUIRED", "The selected source is no longer connected."),
      "SOURCE_REQUIRED",
      "The selected source is no longer connected.",
      db,
    );
    return;
  }
  if (runSource.provider === "github") {
    await executeGitHubPullRequestAnalysis(
      workspaceId,
      runId,
      input,
      new GitHubClient(getGitHubAppConfig()),
      db,
    );
    return;
  }
  await executeConfluencePageAnalysis(workspaceId, runId, input, db);
}
