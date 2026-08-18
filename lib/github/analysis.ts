import { and, eq, inArray } from "drizzle-orm";
import { getDb, type SpecGraphDb } from "../../db";
import {
  analysisRuns,
  artifacts,
  changeEvents,
  githubInstallations,
  graphNodes,
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
import { ApiError } from "../server/http";
import { createManualRun, getRun } from "../server/specgraph-repository";
import { parsePullRequestNumber } from "./targets";

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
    const [selectedSource] = await db
      .select({
        id: sources.id,
        name: sources.name,
        provider: sources.provider,
        installationId: githubInstallations.externalInstallationId,
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
    const changeId = `chg_${crypto.randomUUID()}`;
    const changedPaths = new Set(files.map((file) => file.filename));
    await db.insert(changeEvents).values({
      id: changeId,
      workspaceId,
      sourceId: selectedSource.id,
      trigger: "manual",
      title: `PR #${pull.number}: ${pull.title}`,
      summary: `${files.length} changed ${files.length === 1 ? "file" : "files"} in ${selectedSource.name}.`,
      evidenceSummary:
        "SpecGraph followed deterministic imports, documentation links, explicit references, shared OpenAPI endpoints, and connected documentation from the changed files.",
      sourceLabel: `${selectedSource.name}#${pull.number}`,
      sourceUrl: pull.htmlUrl,
      beforeRevision: pull.baseSha,
      afterRevision: pull.headSha,
      actor: pull.userLogin,
      occurredAt: now,
      createdAt: now,
    });
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

    const changedNodes = files.length
      ? await db
          .select({ id: graphNodes.id, path: artifacts.path })
          .from(graphNodes)
          .innerJoin(artifacts, eq(graphNodes.artifactId, artifacts.id))
          .where(
            and(
              eq(artifacts.sourceId, selectedSource.id),
              inArray(artifacts.path, [...changedPaths]),
            ),
          )
      : [];
    await persistDeterministicFindings(workspaceId, runId, changedNodes, db);
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
