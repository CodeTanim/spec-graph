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
import type { GitHubSourceProvider } from "../providers/source-provider";

const MAX_FILES = 60;
const MAX_FILE_BYTES = 160_000;
const MAX_TOTAL_BYTES = 4_000_000;
const FETCH_CONCURRENCY = 6;

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
    if (entries.length > MAX_FILES) {
      throw new ApiError(
        413,
        "REPOSITORY_FILE_LIMIT",
        `This MVP indexes up to ${MAX_FILES} supported files per repository.`,
      );
    }
    const totalBytes = entries.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new ApiError(
        413,
        "REPOSITORY_SIZE_LIMIT",
        "The supported files in this repository exceed the current MVP size limit.",
      );
    }

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
    const existingByPath = new Map(existingArtifacts.map((item) => [item.externalId, item]));
    const artifactIds = new Map<string, string>();
    const nodeIds = new Map<string, string>();

    for (const file of files) {
      const existing = existingByPath.get(file.path);
      const artifactId = existing?.id || `art_${crypto.randomUUID()}`;
      const canonicalUrl = githubUrl(record.source.name, revision, file.path);
      await db
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
      artifactIds.set(file.path, artifactId);
      await db
        .insert(artifactVersions)
        .values({
          id: `ver_${crypto.randomUUID()}`,
          artifactId,
          revision,
          contentHash: file.hash,
          extractedText: file.content,
          createdAt: now,
        })
        .onConflictDoNothing({
          target: [artifactVersions.artifactId, artifactVersions.revision],
        });

      const [existingNode] = await db
        .select()
        .from(graphNodes)
        .where(
          and(
            eq(graphNodes.artifactId, artifactId),
            eq(graphNodes.stableKey, `file:${file.path}`),
          ),
        )
        .limit(1);
      const nodeId = existingNode?.id || `node_${crypto.randomUUID()}`;
      await db
        .insert(graphNodes)
        .values({
          id: nodeId,
          artifactId,
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
      nodeIds.set(file.path, nodeId);
    }

    const currentPaths = new Set(files.map((file) => file.path));
    for (const existing of existingArtifacts) {
      if (!currentPaths.has(existing.externalId)) {
        await db.delete(artifacts).where(eq(artifacts.id, existing.id));
      }
    }

    const allNodeIds = [...nodeIds.values()];
    if (allNodeIds.length) {
      await db
        .delete(relationships)
        .where(
          or(
            inArray(relationships.fromNodeId, allNodeIds),
            inArray(relationships.toNodeId, allNodeIds),
          ),
        );
    }
    const knownPaths = new Set(files.map((file) => file.path));
    const openApiEndpoints = new Map(
      files
        .filter((file) => file.kind === "openapi")
        .map((file) => [file.path, extractOpenApiEndpoints(file.content)]),
    );
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
        await db
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
          });
      }
    }

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
