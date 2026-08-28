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
  parseArtifactGraph,
  type IndexedArtifactKind,
} from "./artifacts";
import { contentHash } from "./crypto";
import { assertRepositoryWithinLimits } from "./limits";
import type { GitHubSourceProvider } from "../providers/source-provider";
import { pruneArtifactVersions } from "../providers/version-retention";
import { parseOpenApiContract, type ParsedOpenApiContract } from "../openapi/parser";

const MAX_FILE_BYTES = 160_000;
const FETCH_CONCURRENCY = 12;
const DB_BATCH_SIZE = 20;
const DB_IN_LIST_SIZE = 40;

type DbStatement = PromiseLike<unknown>;

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

async function executeInBatches(statements: DbStatement[]): Promise<void> {
  for (let index = 0; index < statements.length; index += DB_BATCH_SIZE) {
    const batch = statements.slice(index, index + DB_BATCH_SIZE);
    if (!batch.length) continue;
    for (const statement of batch) await statement;
  }
}

export async function syncGitHubSource(
  workspaceId: string,
  sourceId: string,
  client: GitHubSourceProvider,
  db: SpecGraphDb = getDb(),
  revisionOverride?: string,
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
    const revision = revisionOverride || await client.branchRevision(
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
    const previousContentByPath = new Map<string, string>();
    const existingById = new Map(existingArtifacts.map((item) => [item.id, item]));
    const existingArtifactIds = existingArtifacts.map((item) => item.id);
    for (let index = 0; index < existingArtifactIds.length; index += DB_IN_LIST_SIZE) {
      const versions = await db
        .select({
          artifactId: artifactVersions.artifactId,
          revision: artifactVersions.revision,
          content: artifactVersions.extractedText,
        })
        .from(artifactVersions)
        .where(
          inArray(
            artifactVersions.artifactId,
            existingArtifactIds.slice(index, index + DB_IN_LIST_SIZE),
          ),
        );
      for (const version of versions) {
        const artifact = existingById.get(version.artifactId);
        if (artifact?.currentRevision === version.revision) {
          previousContentByPath.set(artifact.externalId, version.content);
        }
      }
    }
    const knownPaths = new Set(files.map((file) => file.path));
    const openApiContracts = new Map<string, ParsedOpenApiContract[]>();
    for (const file of files.filter((item) => item.kind === "openapi")) {
      const contracts: ParsedOpenApiContract[] = [];
      for (const content of [file.content, previousContentByPath.get(file.path)]) {
        if (!content) continue;
        try {
          contracts.push(parseOpenApiContract(content));
        } catch {
          // Invalid contracts remain indexed as files, but cannot create structured edges.
        }
      }
      openApiContracts.set(file.path, contracts);
    }
    const parsedByPath = new Map(
      files.map((file) => [
        file.path,
        parseArtifactGraph(
          file.path,
          file.kind,
          file.content,
          knownPaths,
          openApiContracts,
        ),
      ]),
    );
    const existingNodes = await db
      .select({ node: graphNodes, path: artifacts.externalId })
      .from(graphNodes)
      .innerJoin(artifacts, eq(graphNodes.artifactId, artifacts.id))
      .where(eq(artifacts.sourceId, sourceId));
    const existingByPath = new Map(existingArtifacts.map((item) => [item.externalId, item]));
    const existingNodeByKey = new Map(
      existingNodes.map((item) => [
        `${item.path}\u0000${item.node.stableKey}`,
        item.node,
      ]),
    );
    const artifactIds = new Map<string, string>();
    const nodeIds = new Map<string, Map<string, string>>();

    for (const file of files) {
      const existing = existingByPath.get(file.path);
      const artifactId = existing?.id || `art_${crypto.randomUUID()}`;
      artifactIds.set(file.path, artifactId);
      const ids = new Map<string, string>();
      for (const node of parsedByPath.get(file.path)!.nodes) {
        const existingNode = existingNodeByKey.get(
          `${file.path}\u0000${node.stableKey}`,
        );
        ids.set(node.stableKey, existingNode?.id || `node_${crypto.randomUUID()}`);
      }
      nodeIds.set(file.path, ids);
    }

    await executeInBatches(
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
      files.flatMap((file) => {
        const parsed = parsedByPath.get(file.path)!;
        return parsed.nodes.map((node) => {
          const existingNode = existingNodeByKey.get(
            `${file.path}\u0000${node.stableKey}`,
          );
          return db
            .insert(graphNodes)
            .values({
              id: nodeIds.get(file.path)!.get(node.stableKey)!,
              artifactId: artifactIds.get(file.path)!,
              stableKey: node.stableKey,
              kind: node.kind,
              name: node.name,
              startLine: node.startLine,
              endLine: node.endLine,
              contentHash: file.hash,
              createdAt: existingNode?.createdAt || now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: [graphNodes.artifactId, graphNodes.stableKey],
              set: {
                kind: node.kind,
                name: node.name,
                startLine: node.startLine,
                endLine: node.endLine,
                contentHash: file.hash,
                updatedAt: now,
              },
            });
        });
      }),
    );

    const currentPaths = new Set(files.map((file) => file.path));
    const currentNodeIds = new Set(
      [...nodeIds.values()].flatMap((ids) => [...ids.values()]),
    );
    const staleNodeIds = existingNodes
      .filter((item) => currentPaths.has(item.path) && !currentNodeIds.has(item.node.id))
      .map((item) => item.node.id);
    for (let index = 0; index < staleNodeIds.length; index += DB_IN_LIST_SIZE) {
      await db
        .delete(graphNodes)
        .where(inArray(graphNodes.id, staleNodeIds.slice(index, index + DB_IN_LIST_SIZE)));
    }

    const removedArtifactIds = existingArtifacts
      .filter((existing) => !currentPaths.has(existing.externalId))
      .map((existing) => existing.id);
    for (let index = 0; index < removedArtifactIds.length; index += DB_IN_LIST_SIZE) {
      await db
        .delete(artifacts)
        .where(inArray(artifacts.id, removedArtifactIds.slice(index, index + DB_IN_LIST_SIZE)));
    }

    const allNodeIds = [...currentNodeIds];
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
    const relationshipInserts: DbStatement[] = [];
    for (const file of files) {
      const fromNodeId = nodeIds.get(file.path)?.get(`file:${file.path}`);
      if (!fromNodeId) continue;
      for (const node of parsedByPath.get(file.path)!.nodes) {
        if (node.stableKey === `file:${file.path}`) continue;
        const toNodeId = nodeIds.get(file.path)?.get(node.stableKey);
        if (!toNodeId) continue;
        relationshipInserts.push(
          db.insert(relationships).values({
            id: `rel_${crypto.randomUUID()}`,
            fromNodeId,
            toNodeId,
            type: "contains",
            origin: "deterministic",
            provenance: "STRUCTURAL",
            analyzerVersion: "parser-v2",
            confidence: 1,
            evidence: `${file.path} defines ${node.name}`,
            evidenceStartLine: node.startLine,
            createdAt: now,
            updatedAt: now,
          }).onConflictDoNothing({
            target: [
              relationships.fromNodeId,
              relationships.toNodeId,
              relationships.type,
              relationships.origin,
            ],
          }),
        );
      }
      for (const reference of parsedByPath.get(file.path)!.references) {
        const toNodeId = nodeIds
          .get(reference.targetPath)
          ?.get(`file:${reference.targetPath}`);
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
            provenance: reference.provenance,
            analyzerVersion: "deterministic-v2",
            confidence: reference.confidence,
            evidence: reference.evidence,
            evidenceStartLine: reference.evidenceStartLine,
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
    await executeInBatches(relationshipInserts);
    await pruneArtifactVersions(sourceId, db);

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
