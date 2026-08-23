import { and, count, eq, inArray, or } from "drizzle-orm";
import { getDb, type SpecGraphDb } from "../../db";
import {
  artifacts,
  artifactVersions,
  githubInstallations,
  graphNodes,
  relationships,
  sources,
} from "../../db/schema";
import { ApiError } from "../server/http";
import {
  classifyGitHubArtifact,
  extractDeterministicReferences,
  extractOpenApiEndpoints,
  type IndexedArtifactKind,
} from "./artifacts";
import { contentHash } from "./crypto";
import { assertRepositoryWithinLimits } from "./limits";
import type { GitHubSourceProvider } from "../providers/source-provider";

const MAX_FILE_BYTES = 160_000;
const FETCH_CONCURRENCY = 12;
const DB_BATCH_SIZE = 20;
const DB_IN_LIST_SIZE = 40;

type DbBatch = Parameters<SpecGraphDb["batch"]>[0];
type DbBatchItem = DbBatch[number];

type IndexedFile = {
  path: string;
  kind: IndexedArtifactKind;
  sha: string;
  content: string;
  hash: string;
};

function githubUrl(repository: string, revision: string, path: string): string {
  return `https://github.com/${repository}/blob/${revision}/${path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

async function mapInBatches<T, R>(
  items: T[],
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += FETCH_CONCURRENCY) {
    results.push(
      ...(await Promise.all(items.slice(index, index + FETCH_CONCURRENCY).map(mapper))),
    );
  }
  return results;
}

async function executeInBatches(
  db: SpecGraphDb,
  statements: DbBatchItem[],
): Promise<void> {
  for (let index = 0; index < statements.length; index += DB_BATCH_SIZE) {
    const batch = statements.slice(index, index + DB_BATCH_SIZE);
    if (batch.length) await db.batch(batch as unknown as DbBatch);
  }
}

function graphKind(kind: IndexedArtifactKind) {
  if (kind === "test") return "test" as const;
  if (kind === "markdown") return "doc_section" as const;
  if (kind === "openapi") return "schema" as const;
  return "file" as const;
}

export async function syncGitHubSource(
  workspaceId: string,
  sourceId: string,
  client: GitHubSourceProvider,
  db: SpecGraphDb = getDb(),
): Promise<{ artifactCount: number; revision: string }> {
  const [record] = await db
    .select({
      source: sources,
      installationExternalId: githubInstallations.externalInstallationId,
    })
    .from(sources)
    .innerJoin(
      githubInstallations,
      eq(sources.githubInstallationId, githubInstallations.id),
    )
    .where(and(eq(sources.id, sourceId), eq(sources.workspaceId, workspaceId)))
    .limit(1);
  if (!record || record.source.provider !== "github") {
    throw new ApiError(404, "SOURCE_NOT_FOUND", "That GitHub source was not found.");
  }

  const branch = record.source.defaultBranch;
  if (!branch) throw new ApiError(409, "SOURCE_BRANCH_REQUIRED", "Choose a branch first.");
  const now = new Date().toISOString();
  await db
    .update(sources)
    .set({ status: "syncing", lastError: null, updatedAt: now })
    .where(eq(sources.id, sourceId));

  try {
    const revision = await client.branchRevision(
      record.installationExternalId,
      record.source.name,
      branch,
    );
    if (
      record.source.currentRevision === revision &&
      record.source.status !== "error"
    ) {
      const [indexed] = await db
        .select({ value: count() })
        .from(artifacts)
        .where(eq(artifacts.sourceId, sourceId));
      await db
        .update(sources)
        .set({ status: "connected", lastSyncedAt: now, updatedAt: now })
        .where(eq(sources.id, sourceId));
      return { artifactCount: indexed?.value ?? 0, revision };
    }
    const tree = await client.repositoryTree(
      record.installationExternalId,
      record.source.name,
      revision,
    );
    if (tree.truncated) {
      throw new ApiError(
        413,
        "REPOSITORY_TREE_TRUNCATED",
        "This repository is too large for the current MVP indexer.",
      );
    }
    const entries = tree.entries.filter((entry) => {
      return (
        entry.type === "blob" &&
        classifyGitHubArtifact(entry.path) !== null &&
        (entry.size ?? 0) <= MAX_FILE_BYTES
      );
    });
    assertRepositoryWithinLimits(entries);

    const files = await mapInBatches(entries, async (entry): Promise<IndexedFile> => {
      const content = await client.blob(record.source.name, entry.sha, tree.token);
      const kind = classifyGitHubArtifact(entry.path);
      if (!kind) throw new Error("Unsupported entry reached the indexer.");
      return {
        path: entry.path,
        kind,
        sha: entry.sha,
        content,
        hash: await contentHash(content),
      };
    });

    const existingArtifacts = await db
      .select()
      .from(artifacts)
      .where(eq(artifacts.sourceId, sourceId));
    const existingNodes = await db
      .select({ node: graphNodes, path: artifacts.externalId })
      .from(graphNodes)
      .innerJoin(artifacts, eq(graphNodes.artifactId, artifacts.id))
      .where(eq(artifacts.sourceId, sourceId));
    const existingByPath = new Map(existingArtifacts.map((item) => [item.externalId, item]));
    const existingNodeByPath = new Map(existingNodes.map((item) => [item.path, item.node]));
    const artifactIds = new Map<string, string>();
    const nodeIds = new Map<string, string>();

    for (const file of files) {
      const existing = existingByPath.get(file.path);
      const artifactId = existing?.id || `art_${crypto.randomUUID()}`;
      const existingNode = existingNodeByPath.get(file.path);
      artifactIds.set(file.path, artifactId);
      nodeIds.set(file.path, existingNode?.id || `node_${crypto.randomUUID()}`);
    }

    await executeInBatches(
      db,
      files.map((file) => {
        const existing = existingByPath.get(file.path);
        const artifactId = artifactIds.get(file.path)!;
        const canonicalUrl = githubUrl(record.source.name, revision, file.path);
        return db
          .insert(artifacts)
          .values({
          id: artifactId,
          sourceId,
          externalId: file.path,
          kind: file.kind,
          path: file.path,
          title: file.path.split("/").at(-1) || file.path,
          canonicalUrl,
          currentRevision: revision,
          contentHash: file.hash,
          createdAt: existing?.createdAt || now,
          updatedAt: now,
        })
          .onConflictDoUpdate({
            target: [artifacts.sourceId, artifacts.externalId],
            set: {
              kind: file.kind,
              path: file.path,
              title: file.path.split("/").at(-1) || file.path,
              canonicalUrl,
              currentRevision: revision,
              contentHash: file.hash,
              updatedAt: now,
            },
          });
      }),
    );

    await executeInBatches(
      db,
      files.map((file) =>
        db
          .insert(artifactVersions)
          .values({
            id: `ver_${crypto.randomUUID()}`,
            artifactId: artifactIds.get(file.path)!,
            revision,
            contentHash: file.hash,
            extractedText: file.content,
            createdAt: now,
          })
          .onConflictDoNothing({
            target: [artifactVersions.artifactId, artifactVersions.revision],
          }),
      ),
    );

    await executeInBatches(
      db,
      files.map((file) => {
        const existingNode = existingNodeByPath.get(file.path);
        return db
          .insert(graphNodes)
          .values({
          id: nodeIds.get(file.path)!,
          artifactId: artifactIds.get(file.path)!,
          stableKey: `file:${file.path}`,
          kind: graphKind(file.kind),
          name: file.path,
          startLine: 1,
          endLine: file.content.split("\n").length,
          contentHash: file.hash,
          createdAt: existingNode?.createdAt || now,
          updatedAt: now,
        })
          .onConflictDoUpdate({
            target: [graphNodes.artifactId, graphNodes.stableKey],
            set: {
              kind: graphKind(file.kind),
              name: file.path,
              startLine: 1,
              endLine: file.content.split("\n").length,
              contentHash: file.hash,
              updatedAt: now,
            },
          });
      }),
    );

    const currentPaths = new Set(files.map((file) => file.path));
    const removedArtifactIds = existingArtifacts
      .filter((existing) => !currentPaths.has(existing.externalId))
      .map((existing) => existing.id);
    for (let index = 0; index < removedArtifactIds.length; index += DB_IN_LIST_SIZE) {
      await db
        .delete(artifacts)
        .where(inArray(artifacts.id, removedArtifactIds.slice(index, index + DB_IN_LIST_SIZE)));
    }

    const allNodeIds = [...nodeIds.values()];
    for (let index = 0; index < allNodeIds.length; index += DB_IN_LIST_SIZE) {
      const nodeIdBatch = allNodeIds.slice(index, index + DB_IN_LIST_SIZE);
      await db
        .delete(relationships)
        .where(
          or(
            inArray(relationships.fromNodeId, nodeIdBatch),
            inArray(relationships.toNodeId, nodeIdBatch),
          ),
        );
    }
    const knownPaths = new Set(files.map((file) => file.path));
    const openApiEndpoints = new Map(
      files
        .filter((file) => file.kind === "openapi")
        .map((file) => [file.path, extractOpenApiEndpoints(file.content)]),
    );
    const relationshipInserts: DbBatchItem[] = [];
    for (const file of files) {
      const fromNodeId = nodeIds.get(file.path);
      if (!fromNodeId) continue;
      for (const reference of extractDeterministicReferences(
        file.path,
        file.kind,
        file.content,
        knownPaths,
        openApiEndpoints,
      )) {
        const toNodeId = nodeIds.get(reference.targetPath);
        if (!toNodeId) continue;
        relationshipInserts.push(
          db
            .insert(relationships)
            .values({
            id: `rel_${crypto.randomUUID()}`,
            fromNodeId,
            toNodeId,
            type: reference.type,
            origin: "deterministic",
            confidence: 1,
            evidence: reference.evidence,
            createdAt: now,
            updatedAt: now,
          })
            .onConflictDoNothing({
              target: [
                relationships.fromNodeId,
                relationships.toNodeId,
                relationships.type,
                relationships.origin,
              ],
            }),
        );
      }
    }
    await executeInBatches(db, relationshipInserts);

    await db
      .update(sources)
      .set({
        status: "connected",
        currentRevision: revision,
        lastError: null,
        lastSyncedAt: now,
        updatedAt: now,
      })
      .where(eq(sources.id, sourceId));
    return { artifactCount: files.length, revision };
  } catch (error) {
    const message = error instanceof Error ? error.message : "GitHub synchronization failed.";
    await db
      .update(sources)
      .set({ status: "error", lastError: message, updatedAt: new Date().toISOString() })
      .where(eq(sources.id, sourceId));
    throw error;
  }
}
