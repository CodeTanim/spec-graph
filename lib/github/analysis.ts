import { and, eq, inArray } from "drizzle-orm";
import { getDb, type SpecGraphDb } from "../../db";
import {
  analysisRuns,
  artifacts,
  artifactVersions,
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
import { changedArtifactSnapshot, classifyGitHubArtifact } from "./artifacts";
import { syncGitHubSource } from "./ingestion";
import { parsePullRequestNumber } from "./targets";
import {
  deriveAnalysisScopes,
  deriveAnalysisScopesFromUnifiedPatch,
  parseAnalysisScopes,
  serializeAnalysisScopes,
  type ArtifactContentChange,
} from "../analysis/change-scope";

export type GitHubPushAnalysisInput = {
  branch: string;
  beforeRevision: string | null;
  afterRevision: string;
  changedPaths: string[];
  changeTypes?: Record<string, "added" | "modified" | "deleted">;
};

function actualRevision(revision: string | null): string | null {
  return revision && !/^0+$/.test(revision) ? revision : null;
}

function completePullPatch(
  patch: string | null | undefined,
  additions: number,
  deletions: number,
): string | null {
  if (!patch) return null;
  let observedAdditions = 0;
  let observedDeletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) observedAdditions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) observedDeletions += 1;
  }
  return observedAdditions === additions && observedDeletions === deletions
    ? patch
    : null;
}

async function exactGitHubContentChanges(
  sourceId: string,
  paths: string[],
  beforeRevision: string | null,
  afterRevision: string,
  syncedChanges: ArtifactContentChange[],
  changeTypes: GitHubPushAnalysisInput["changeTypes"],
  db: SpecGraphDb,
): Promise<ArtifactContentChange[]> {
  const uniquePaths = [...new Set(paths)];
  const before = actualRevision(beforeRevision);
  const normalizedSyncedChanges = syncedChanges.flatMap((change) => {
    const expectedType = changeTypes?.[change.path];
    const afterMatches = change.afterRevision === afterRevision || change.afterRevision === null;
    if (!afterMatches) return [];
    if (expectedType === "added") {
      return change.beforeText === null && change.afterText !== null
        ? [{ ...change, beforeRevision: null, afterRevision }]
        : [];
    }
    if (expectedType === "deleted") {
      return change.beforeRevision === before && change.afterText === null
        ? [{ ...change, beforeRevision: before, afterRevision: null }]
        : [];
    }
    if (change.beforeRevision !== before || change.afterRevision !== afterRevision) return [];
    return [change];
  });
  const syncedByPath = new Map(
    normalizedSyncedChanges.map((change) => [change.path, change]),
  );
  const unresolvedPaths = uniquePaths.filter((path) => !syncedByPath.has(path));
  if (!unresolvedPaths.length) return uniquePaths.flatMap((path) => syncedByPath.get(path) || []);

  const indexed = await db
    .select({
      id: artifacts.id,
      path: artifacts.externalId,
      kind: artifacts.kind,
    })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.sourceId, sourceId),
        inArray(artifacts.externalId, unresolvedPaths),
      ),
    );
  const byPath = new Map(indexed.map((artifact) => [artifact.path, artifact]));
  const versions = indexed.length
    ? await db
        .select({
          artifactId: artifactVersions.artifactId,
          revision: artifactVersions.revision,
          text: artifactVersions.extractedText,
        })
        .from(artifactVersions)
        .where(inArray(artifactVersions.artifactId, indexed.map((artifact) => artifact.id)))
    : [];
  const textByVersion = new Map(
    versions.map((version) => [`${version.artifactId}\u0000${version.revision}`, version.text]),
  );
  for (const path of unresolvedPaths) {
    const artifact = byPath.get(path);
    const expectedType = changeTypes?.[path];
    syncedByPath.set(path, {
      artifactId: artifact?.id || null,
      path,
      kind: artifact?.kind || classifyGitHubArtifact(path),
      beforeRevision: expectedType === "added" ? null : before,
      afterRevision: expectedType === "deleted" ? null : afterRevision,
      beforeText:
        expectedType !== "added" && before && artifact
          ? textByVersion.get(`${artifact.id}\u0000${before}`) ?? null
          : null,
      afterText: expectedType !== "deleted" && artifact
        ? textByVersion.get(`${artifact.id}\u0000${afterRevision}`) ?? null
        : null,
    });
  }
  return uniquePaths.flatMap((path) => syncedByPath.get(path) || []);
}

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
        storedBeforeRevision: changeEvents.beforeRevision,
        storedAfterRevision: changeEvents.afterRevision,
        storedAnalysisScopeJson: changeEvents.analysisScopeJson,
        storedTitle: changeEvents.title,
        storedChangedArtifactsJson: changeEvents.changedArtifactsJson,
      })
      .from(analysisRuns)
      .innerJoin(sources, eq(analysisRuns.sourceId, sources.id))
      .leftJoin(changeEvents, eq(analysisRuns.changeEventId, changeEvents.id))
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
    if (files.length !== pull.changedFiles) {
      throw new ApiError(
        413,
        "GITHUB_PULL_FILES_TRUNCATED",
        "This pull request has more changed files than SpecGraph can verify safely.",
      );
    }
    const now = new Date().toISOString();
    const changeId = selectedSource.changeEventId || `chg_${crypto.randomUUID()}`;
    const storedScopes = parseAnalysisScopes(selectedSource.storedAnalysisScopeJson);
    const baseRevision = selectedSource.storedBeforeRevision || pull.baseSha;
    const headRevision = selectedSource.storedAfterRevision || pull.headSha;
    if (
      selectedSource.storedAfterRevision &&
      pull.headSha !== selectedSource.storedAfterRevision &&
      !storedScopes.length
    ) {
      throw new ApiError(
        409,
        "GITHUB_PULL_REVISION_MOVED",
        "That pull request changed before SpecGraph captured its exact revision. The newer GitHub event will be checked instead.",
      );
    }
    const reusingStoredEvent = Boolean(selectedSource.changeEventId && storedScopes.length);
    const changedPaths = new Set(
      reusingStoredEvent
        ? storedScopes.map((scope) => scope.path)
        : files.map((file) => file.filename),
    );
    const pullScopes = storedScopes.length
      ? storedScopes
      : files.flatMap((file) =>
          deriveAnalysisScopesFromUnifiedPatch({
            artifactId: null,
            path: file.filename,
            kind: classifyGitHubArtifact(file.filename),
            beforeRevision: file.status === "added" ? null : baseRevision,
            afterRevision: file.status === "removed" ? null : headRevision,
            patch: completePullPatch(file.patch, file.additions, file.deletions),
          }),
        );
    const changedArtifactsJson = reusingStoredEvent
      ? selectedSource.storedChangedArtifactsJson || "[]"
      : JSON.stringify(
          files.map((file) =>
            changedArtifactSnapshot(
              file.filename,
              `${pull.htmlUrl}/files`,
              file.status === "added"
                ? "added"
                : file.status === "removed"
                  ? "deleted"
                  : file.status === "renamed"
                    ? "renamed"
                    : "modified",
            ),
          ),
        );
    const changeValues = {
      title: `PR #${pull.number}: ${pull.title}`,
      summary: `${files.length} changed ${files.length === 1 ? "file" : "files"} in ${selectedSource.name}.`,
      changedArtifactsJson,
      analysisScopeJson: serializeAnalysisScopes(pullScopes),
      evidenceSummary:
        "SpecGraph checked unchanged linked documentation for code changes, and linked primary code, schemas, or documentation for documentation changes. Related tests may also need review.",
      sourceLabel: `${selectedSource.name}#${pull.number}`,
      sourceUrl: pull.htmlUrl,
      beforeRevision: baseRevision,
      afterRevision: headRevision,
      actor: pull.userLogin,
    };
    if (selectedSource.changeEventId && !reusingStoredEvent) {
      await db
        .update(changeEvents)
        .set(changeValues)
        .where(eq(changeEvents.id, selectedSource.changeEventId));
    } else if (!selectedSource.changeEventId) {
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
        title: reusingStoredEvent
          ? selectedSource.storedTitle || `PR #${pull.number}: ${pull.title}`
          : `PR #${pull.number}: ${pull.title}`,
        target: `#${pull.number}`,
        progress: 45,
        updatedAt: now,
      })
      .where(eq(analysisRuns.id, runId));

    const sync = await syncGitHubSource(
      workspaceId,
      selectedSource.id,
      client,
      db,
      headRevision,
    );
    if (sync.changed) {
      await rebuildCrossSourceRelationships(workspaceId, selectedSource.id, db);
    }
    const resolvedChanges = await resolveGitHubChangedNodes(
      selectedSource.id,
      [...changedPaths],
      baseRevision,
      headRevision,
      db,
    );
    if (resolvedChanges.openApiArtifacts.size) {
      await db
        .update(changeEvents)
        .set({
          changedArtifactsJson: enrichChangedArtifacts(
            changedArtifactsJson,
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
        analysisScopeJson: changeEvents.analysisScopeJson,
      })
      .from(analysisRuns)
      .innerJoin(sources, eq(analysisRuns.sourceId, sources.id))
      .innerJoin(changeEvents, eq(analysisRuns.changeEventId, changeEvents.id))
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
    failureStage = "capture_change_scope";
    const existingScopes = parseAnalysisScopes(selectedSource.analysisScopeJson);
    if (!existingScopes.length) {
      const contentChanges = await exactGitHubContentChanges(
        selectedSource.id,
        input.changedPaths,
        input.beforeRevision,
        input.afterRevision,
        sync.contentChanges,
        input.changeTypes,
        db,
      );
      const scopes = contentChanges.flatMap(deriveAnalysisScopes);
      await db
        .update(changeEvents)
        .set({ analysisScopeJson: serializeAnalysisScopes(scopes) })
        .where(eq(changeEvents.id, selectedSource.changeEventId));
    }
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
