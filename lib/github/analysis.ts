import { and, desc, eq, inArray, or } from "drizzle-orm";
import { getDb, type SpecGraphDb } from "../../db";
import {
  analysisRuns,
  artifacts,
  artifactVersions,
  changeEvents,
  findingEvidence,
  findings,
  githubInstallations,
  graphNodes,
  relationships,
  runAttempts,
  sources,
} from "../../db/schema";
import type { StartRunInput, StartRunResponse } from "../contracts/specgraph";
import { ApiError } from "../server/http";
import {
  createManualRun,
  getRun,
} from "../server/specgraph-repository";
import type { GitHubSourceProvider } from "../providers/source-provider";
import { parsePullRequestNumber } from "./targets";

function sourceLink(url: string | null, start = 1, end = 4): string | null {
  if (!url) return null;
  return `${url}#L${start}-L${end}`;
}

function excerpt(content: string): string {
  const lines = content.split("\n").slice(0, 4).join("\n").trim();
  return lines || "The indexed artifact is empty.";
}

function relationshipReason(type: string, changedPath: string): string {
  switch (type) {
    case "imports":
      return `It is connected to ${changedPath} through a code import.`;
    case "links":
      return `It is connected to ${changedPath} through a documentation link.`;
    case "covers_endpoint":
      return `It shares an API endpoint with ${changedPath}.`;
    default:
      return `It explicitly references ${changedPath}.`;
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
  const runId = created.run.id;
  const now = new Date().toISOString();
  const attemptId = `attempt_${crypto.randomUUID()}`;
  await db
    .update(analysisRuns)
    .set({ status: "running", progress: 10, attempts: 1, startedAt: now, updatedAt: now })
    .where(eq(analysisRuns.id, runId));
  await db.insert(runAttempts).values({
    id: attemptId,
    runId,
    attempt: 1,
    stage: "github_pull_request",
    status: "running",
    startedAt: now,
  });

  try {
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
        "SpecGraph followed deterministic imports, documentation links, explicit file references, and shared OpenAPI endpoints from the changed files.",
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
    const changedNodeIds = changedNodes.map((node) => node.id);
    const changedPathByNode = new Map(changedNodes.map((node) => [node.id, node.path]));
    const edges = changedNodeIds.length
      ? await db
          .select()
          .from(relationships)
          .where(
            or(
              inArray(relationships.fromNodeId, changedNodeIds),
              inArray(relationships.toNodeId, changedNodeIds),
            ),
          )
      : [];
    const affectedNodeIds = [
      ...new Set(
        edges
          .map((edge) =>
            changedPathByNode.has(edge.fromNodeId) ? edge.toNodeId : edge.fromNodeId,
          )
          .filter((id) => !changedPathByNode.has(id)),
      ),
    ];
    const affectedRecords = affectedNodeIds.length
      ? await db
          .select({
            nodeId: graphNodes.id,
            artifactId: artifacts.id,
            title: artifacts.title,
            path: artifacts.path,
            currentRevision: artifacts.currentRevision,
            canonicalUrl: artifacts.canonicalUrl,
          })
          .from(graphNodes)
          .innerJoin(artifacts, eq(graphNodes.artifactId, artifacts.id))
          .where(inArray(graphNodes.id, affectedNodeIds))
      : [];
    const affectedByNode = new Map(affectedRecords.map((record) => [record.nodeId, record]));
    const persisted = new Set<string>();
    for (const edge of edges) {
      const changedNodeId = changedPathByNode.has(edge.fromNodeId)
        ? edge.fromNodeId
        : edge.toNodeId;
      const affectedNodeId = changedNodeId === edge.fromNodeId ? edge.toNodeId : edge.fromNodeId;
      const affected = affectedByNode.get(affectedNodeId);
      if (!affected || persisted.has(affectedNodeId)) continue;
      persisted.add(affectedNodeId);
      const changedPath = changedPathByNode.get(changedNodeId) || "the changed file";
      const [version] = await db
        .select()
        .from(artifactVersions)
        .where(
          and(
            eq(artifactVersions.artifactId, affected.artifactId),
            affected.currentRevision
              ? eq(artifactVersions.revision, affected.currentRevision)
              : eq(artifactVersions.artifactId, affected.artifactId),
          ),
        )
        .orderBy(desc(artifactVersions.createdAt))
        .limit(1);
      const findingId = `finding_${crypto.randomUUID()}`;
      await db.insert(findings).values({
        id: findingId,
        runId,
        changedNodeId,
        affectedNodeId,
        title: affected.title,
        summary: relationshipReason(edge.type, changedPath),
        confidence: edge.confidence,
        origin: "deterministic",
        status: "open",
        deduplicationKey: `${changedNodeId}:${affectedNodeId}`,
        createdAt: now,
        updatedAt: now,
      });
      await db.insert(findingEvidence).values({
        id: `evidence_${crypto.randomUUID()}`,
        findingId,
        artifactVersionId: version?.id || null,
        location: `${affected.path}:1`,
        startLine: 1,
        endLine: 4,
        excerpt: version ? excerpt(version.extractedText) : edge.evidence,
        sourceUrl: sourceLink(affected.canonicalUrl),
        type: "relationship",
        createdAt: now,
      });
    }

    const completedAt = new Date().toISOString();
    await db
      .update(analysisRuns)
      .set({
        status: "succeeded",
        progress: 100,
        completedAt,
        updatedAt: completedAt,
      })
      .where(eq(analysisRuns.id, runId));
    await db
      .update(runAttempts)
      .set({ status: "succeeded", finishedAt: completedAt })
      .where(eq(runAttempts.id, attemptId));
  } catch (error) {
    const failedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : "GitHub analysis failed.";
    const code = error instanceof ApiError ? error.code : "GITHUB_ANALYSIS_FAILED";
    await db
      .update(analysisRuns)
      .set({
        status: "failed",
        errorCode: code,
        errorMessage: message,
        completedAt: failedAt,
        updatedAt: failedAt,
      })
      .where(eq(analysisRuns.id, runId));
    await db
      .update(runAttempts)
      .set({ status: "failed", errorCode: code, errorMessage: message, finishedAt: failedAt })
      .where(eq(runAttempts.id, attemptId));
  }

  return { run: await getRun(workspaceId, runId, db) };
}
