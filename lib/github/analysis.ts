import { and, eq } from "drizzle-orm";
import { getDb, type SpecGraphDb } from "../../db";
import {
  analysisRuns,
  changeEvents,
  githubInstallations,
  sources,
} from "../../db/schema";
import { persistDeterministicFindings } from "../analysis/deterministic";
import {
  beginRunAttempt,
  completeRunAttempt,
  failRunAttempt,
} from "../analysis/run-lifecycle";
import type { StartRunInput, StartRunResponse } from "../contracts/specgraph";
import type { GitHubSourceProvider } from "../providers/source-provider";
import { rebuildCrossSourceRelationships } from "../providers/cross-source-relationships";
import { ApiError } from "../server/http";
import { createManualRun, getRun } from "../server/specgraph-repository";
import {
  enrichChangedArtifacts,
  resolveGitHubChangedNodes,
} from "../openapi/changes";
import { changedArtifactSnapshot } from "./artifacts";
import { syncGitHubSource } from "./ingestion";
import { parsePullRequestNumber } from "./targets";

export type GitHubPushAnalysisInput = {
  branch: string;
  beforeRevision: string | null;
  afterRevision: string;
  changedPaths: string[];
};

export async function executeGitHubPullRequestAnalysis(
  workspaceId: string,
  runId: string,
  input: StartRunInput,
  client: GitHubSourceProvider,
  db: SpecGraphDb = getDb(),
): Promise<void> {
  let attemptId: string | null = null;

  try {
    attemptId = await beginRunAttempt(runId, "github_pull_request", db);
    if (!attemptId) return;
    const [selectedSource] = await db
      .select({
        id: sources.id,
        name: sources.name,
        provider: sources.provider,
        installationId: githubInstallations.externalInstallationId,
        trigger: analysisRuns.trigger,
        changeEventId: analysisRuns.changeEventId,
      })
      .from(analysisRuns)
      .innerJoin(sources, eq(analysisRuns.sourceId, sources.id))
      .leftJoin(
        githubInstallations,
        eq(sources.githubInstallationId, githubInstallations.id),
      )
      .where(
        and(
          eq(analysisRuns.id, runId),
          eq(analysisRuns.workspaceId, workspaceId),
          eq(sources.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!selectedSource || selectedSource.provider !== "github" || !selectedSource.installationId) {
      throw new ApiError(409, "GITHUB_SOURCE_REQUIRED", "Choose a connected GitHub source.");
    }

    const pullNumber = parsePullRequestNumber(input.target, selectedSource.name);
    const { pull, files } = await client.pullRequest(
      selectedSource.installationId,
      selectedSource.name,
      pullNumber,
    );
    const now = new Date().toISOString();
    const changeId = selectedSource.changeEventId || `chg_${crypto.randomUUID()}`;
    const changedPaths = new Set(files.map((file) => file.filename));
    const changeValues = {
      title: `PR #${pull.number}: ${pull.title}`,
      summary: `${files.length} changed ${files.length === 1 ? "file" : "files"} in ${selectedSource.name}.`,
      changedArtifactsJson: JSON.stringify(
        files.map((file) =>
          changedArtifactSnapshot(file.filename, `${pull.htmlUrl}/files`),
        ),
      ),
      evidenceSummary:
        "SpecGraph checked unchanged linked documentation for code changes, and linked primary code, schemas, or documentation for documentation changes. Related tests may also need review.",
      sourceLabel: `${selectedSource.name}#${pull.number}`,
      sourceUrl: pull.htmlUrl,
      beforeRevision: pull.baseSha,
      afterRevision: pull.headSha,
      actor: pull.userLogin,
    };
    if (selectedSource.changeEventId) {
      await db
        .update(changeEvents)
        .set(changeValues)
        .where(eq(changeEvents.id, selectedSource.changeEventId));
    } else {
      await db.insert(changeEvents).values({
        id: changeId,
        workspaceId,
        sourceId: selectedSource.id,
        trigger: selectedSource.trigger,
        ...changeValues,
        occurredAt: now,
        createdAt: now,
      });
    }
    await db
      .update(analysisRuns)
      .set({
        changeEventId: changeId,
        title: `PR #${pull.number}: ${pull.title}`,
        target: `#${pull.number}`,
        progress: 45,
        updatedAt: now,
      })
      .where(eq(analysisRuns.id, runId));

    const sync = await syncGitHubSource(workspaceId, selectedSource.id, client, db);
    if (sync.changed) {
      await rebuildCrossSourceRelationships(workspaceId, selectedSource.id, db);
    }
    const resolvedChanges = await resolveGitHubChangedNodes(
      selectedSource.id,
      [...changedPaths],
      pull.baseSha,
      pull.headSha,
      db,
    );
    if (resolvedChanges.openApiArtifacts.size) {
      await db
        .update(changeEvents)
        .set({
          changedArtifactsJson: enrichChangedArtifacts(
            changeValues.changedArtifactsJson,
            resolvedChanges.openApiArtifacts,
          ),
        })
        .where(eq(changeEvents.id, changeId));
    }
    await persistDeterministicFindings(
      workspaceId,
      runId,
      resolvedChanges.changedNodes,
      db,
    );
    await completeRunAttempt(runId, attemptId, db);
  } catch (error) {
    await failRunAttempt(
      runId,
      attemptId,
      error,
      "GITHUB_ANALYSIS_FAILED",
      "GitHub analysis failed.",
      db,
    );
  }
}

export async function executeGitHubPushAnalysis(
  workspaceId: string,
  runId: string,
  input: GitHubPushAnalysisInput,
  client: GitHubSourceProvider,
  db: SpecGraphDb = getDb(),
): Promise<void> {
  let attemptId: string | null = null;
  let failureStage = "claim_run";
  try {
    attemptId = await beginRunAttempt(runId, "github_push", db);
    if (!attemptId) return;
    failureStage = "load_source";
    const [selectedSource] = await db
      .select({
        id: sources.id,
        provider: sources.provider,
        installationId: githubInstallations.externalInstallationId,
        changeEventId: analysisRuns.changeEventId,
      })
      .from(analysisRuns)
      .innerJoin(sources, eq(analysisRuns.sourceId, sources.id))
      .leftJoin(
        githubInstallations,
        eq(sources.githubInstallationId, githubInstallations.id),
      )
      .where(
        and(
          eq(analysisRuns.id, runId),
          eq(analysisRuns.workspaceId, workspaceId),
          eq(sources.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (
      !selectedSource ||
      selectedSource.provider !== "github" ||
      !selectedSource.installationId ||
      !selectedSource.changeEventId
    ) {
      throw new ApiError(409, "GITHUB_SOURCE_REQUIRED", "Choose a connected GitHub source.");
    }

    failureStage = "sync_source";
    const sync = await syncGitHubSource(
      workspaceId,
      selectedSource.id,
      client,
      db,
      input.afterRevision,
    );
    if (sync.changed) {
      failureStage = "rebuild_relationships";
      await rebuildCrossSourceRelationships(workspaceId, selectedSource.id, db);
    }
    failureStage = "update_progress";
    const now = new Date().toISOString();
    await db
      .update(analysisRuns)
      .set({ progress: 55, updatedAt: now })
      .where(eq(analysisRuns.id, runId));
    failureStage = "resolve_changes";
    const resolvedChanges = await resolveGitHubChangedNodes(
      selectedSource.id,
      input.changedPaths,
      input.beforeRevision,
      input.afterRevision,
      db,
    );
    if (resolvedChanges.openApiArtifacts.size) {
      failureStage = "enrich_change";
      const [event] = await db
        .select({ changedArtifactsJson: changeEvents.changedArtifactsJson })
        .from(changeEvents)
        .where(eq(changeEvents.id, selectedSource.changeEventId))
        .limit(1);
      if (event) {
        await db
          .update(changeEvents)
          .set({
            changedArtifactsJson: enrichChangedArtifacts(
              event.changedArtifactsJson,
              resolvedChanges.openApiArtifacts,
            ),
          })
          .where(eq(changeEvents.id, selectedSource.changeEventId));
      }
    }
    failureStage = "persist_findings";
    await persistDeterministicFindings(
      workspaceId,
      runId,
      resolvedChanges.changedNodes,
      db,
    );
    failureStage = "complete_run";
    await completeRunAttempt(runId, attemptId, db);
  } catch (error) {
    await failRunAttempt(
      runId,
      attemptId,
      error,
      "GITHUB_PUSH_ANALYSIS_FAILED",
      "GitHub push analysis failed.",
      db,
      { stage: failureStage },
    );
  }
}

export async function runGitHubPullRequestAnalysis(
  workspaceId: string,
  userId: string,
  input: StartRunInput,
  client: GitHubSourceProvider,
  db: SpecGraphDb = getDb(),
): Promise<StartRunResponse> {
  const created = await createManualRun(workspaceId, userId, input, db);
  await executeGitHubPullRequestAnalysis(workspaceId, created.run.id, input, client, db);
  return { run: await getRun(workspaceId, created.run.id, db) };
}
