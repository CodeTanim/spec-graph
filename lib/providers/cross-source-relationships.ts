import { and, desc, eq, inArray, like, or } from "drizzle-orm";
import { getDb, type SpecGraphDb } from "../../db";
import {
  artifacts,
  artifactVersions,
  graphNodes,
  relationships,
  sources,
} from "../../db/schema";
import {
  openApiTextMatches,
  parseOpenApiContract,
  type ParsedOpenApiContract,
} from "../openapi/parser";
import {
  discoverEntityRelationships,
  type EntityArtifact,
} from "../graph/entity-relationships";
import {
  sourceGroupIdForSource,
  sourceIdsForGroup,
} from "./source-groups";

async function rebuildPair(
  repositorySourceId: string,
  documentationSourceId: string,
  db: SpecGraphDb,
) {
  const repositoryNodes = await db
    .select({
      nodeId: graphNodes.id,
      artifactId: artifacts.id,
      kind: artifacts.kind,
      path: artifacts.path,
      currentRevision: artifacts.currentRevision,
      stableKey: graphNodes.stableKey,
    })
    .from(graphNodes)
    .innerJoin(artifacts, eq(graphNodes.artifactId, artifacts.id))
    .where(
      and(
        eq(artifacts.sourceId, repositorySourceId),
        like(graphNodes.stableKey, "file:%"),
      ),
    );
  const repositoryRootNodes = repositoryNodes.filter(
    (item) => item.stableKey === `file:${item.path}`,
  );
  const documentationNodeRecords = await db
    .select({
      nodeId: graphNodes.id,
      stableKey: graphNodes.stableKey,
      text: artifactVersions.extractedText,
    })
    .from(graphNodes)
    .innerJoin(artifacts, eq(graphNodes.artifactId, artifacts.id))
    .innerJoin(
      artifactVersions,
      and(
        eq(artifactVersions.artifactId, artifacts.id),
        eq(artifactVersions.revision, artifacts.currentRevision),
      ),
    )
    .where(
      and(
        eq(artifacts.sourceId, documentationSourceId),
        like(graphNodes.stableKey, "page:%"),
      ),
    );
  const documentationNodes = documentationNodeRecords;

  const repositoryNodeIds = repositoryRootNodes.map((item) => item.nodeId);
  const documentationNodeIds = documentationNodes.map((item) => item.nodeId);
  if (repositoryNodeIds.length && documentationNodeIds.length) {
    await db.delete(relationships).where(and(
      or(
        eq(relationships.type, "documents"),
        like(relationships.type, "covers_openapi:%"),
      ),
      or(
        and(
          inArray(relationships.fromNodeId, documentationNodeIds),
          inArray(relationships.toNodeId, repositoryNodeIds),
        ),
        and(
          inArray(relationships.fromNodeId, repositoryNodeIds),
          inArray(relationships.toNodeId, documentationNodeIds),
        ),
      ),
    ));
  }

  const openApiArtifacts = repositoryRootNodes.filter((item) => item.kind === "openapi");
  const openApiVersions = openApiArtifacts.length
    ? await db
        .select()
        .from(artifactVersions)
        .where(inArray(
          artifactVersions.artifactId,
          openApiArtifacts.map((item) => item.artifactId),
        ))
        .orderBy(desc(artifactVersions.createdAt))
    : [];
  const contractsByPath = new Map<string, ParsedOpenApiContract[]>();
  for (const artifact of openApiArtifacts) {
    const contracts: ParsedOpenApiContract[] = [];
    const versions = openApiVersions
      .filter((version) => version.artifactId === artifact.artifactId)
      .sort((left, right) => {
        if (left.revision === artifact.currentRevision) return -1;
        if (right.revision === artifact.currentRevision) return 1;
        return right.createdAt.localeCompare(left.createdAt);
      })
      .slice(0, 2);
    for (const version of versions) {
      try {
        contracts.push(parseOpenApiContract(version.extractedText));
      } catch {
        // Keep the source connected even when a contract cannot be parsed.
      }
    }
    contractsByPath.set(artifact.path, contracts);
  }

  const now = new Date().toISOString();
  for (const documentation of documentationNodes) {
    for (const repository of repositoryRootNodes) {
      const references = [] as Array<{
        type: string;
        evidence: string;
        evidenceStartLine: number;
      }>;
      if (documentation.text.includes(repository.path)) {
        const evidenceLines = documentation.text.split("\n");
        const evidenceIndex = evidenceLines.findIndex((line) =>
          line.includes(repository.path),
        );
        references.push({
          type: "documents",
          evidence:
            evidenceLines[evidenceIndex]?.trim() ||
            `Confluence page references ${repository.path}`,
          evidenceStartLine: evidenceIndex >= 0 ? evidenceIndex + 1 : 1,
        });
      }
      if (repository.kind === "openapi") {
        for (const match of openApiTextMatches(
          documentation.text,
          contractsByPath.get(repository.path) || [],
        )) {
          references.push({
            type: `covers_openapi:${match.matchKey}`,
            evidence: match.evidence,
            evidenceStartLine: match.evidenceStartLine,
          });
        }
      }
      for (const reference of references) {
        await db.insert(relationships).values({
          id: `rel_${crypto.randomUUID()}`,
          fromNodeId: documentation.nodeId,
          toNodeId: repository.nodeId,
          type: reference.type,
          origin: "deterministic",
          provenance: reference.type === "documents" ? "EXACT_PATH" : "OPENAPI_ENTITY",
          analyzerVersion: "deterministic-v2",
          confidence: 1,
          evidence: reference.evidence,
          evidenceStartLine: reference.evidenceStartLine,
          createdAt: now,
          updatedAt: now,
        }).onConflictDoNothing({
          target: [
            relationships.fromNodeId,
            relationships.toNodeId,
            relationships.type,
            relationships.origin,
          ],
        });
      }
    }
  }
}

async function rebuildEntityRelationships(
  memberIds: string[],
  db: SpecGraphDb,
) {
  const artifactRows = await db
    .select({
      artifactId: artifacts.id,
      externalId: artifacts.externalId,
      sourceId: artifacts.sourceId,
      kind: artifacts.kind,
      path: artifacts.path,
      text: artifactVersions.extractedText,
    })
    .from(artifacts)
    .innerJoin(
      artifactVersions,
      and(
        eq(artifactVersions.artifactId, artifacts.id),
        eq(artifactVersions.revision, artifacts.currentRevision),
      ),
    )
    .where(inArray(artifacts.sourceId, memberIds));

  if (!artifactRows.length) return;
  const artifactIds = artifactRows.map((row) => row.artifactId);
  const nodeRows = await db
    .select({
      artifactId: graphNodes.artifactId,
      nodeId: graphNodes.id,
      stableKey: graphNodes.stableKey,
    })
    .from(graphNodes)
    .where(inArray(graphNodes.artifactId, artifactIds));

  const byArtifact = new Map<string, EntityArtifact>();
  for (const row of artifactRows) {
    byArtifact.set(row.artifactId, {
      artifactId: row.artifactId,
      sourceId: row.sourceId,
      kind: row.kind,
      path: row.path,
      rootNodeId: "",
      text: row.text,
      entityNodeIds: new Map(),
    });
  }
  for (const row of nodeRows) {
    const artifact = byArtifact.get(row.artifactId);
    if (!artifact) continue;
    if (
      row.stableKey === `file:${artifact.path}` ||
      row.stableKey.startsWith("page:")
    ) {
      artifact.rootNodeId = row.nodeId;
    }
    if (row.stableKey.startsWith("entity:")) {
      artifact.entityNodeIds?.set(row.stableKey.slice("entity:".length), row.nodeId);
    }
  }

  const indexedArtifacts = [...byArtifact.values()].filter(
    (artifact) => artifact.rootNodeId,
  );
  const nodeIds = [...new Set(nodeRows.map((row) => row.nodeId))];
  if (nodeIds.length) {
    await db.delete(relationships).where(and(
      or(
        like(relationships.type, "mentions_entity:%"),
        like(relationships.type, "shares_entity:%"),
      ),
      inArray(relationships.fromNodeId, nodeIds),
      inArray(relationships.toNodeId, nodeIds),
    ));
  }

  const now = new Date().toISOString();
  for (const relationship of discoverEntityRelationships(indexedArtifacts)) {
    await db.insert(relationships).values({
      id: `rel_${crypto.randomUUID()}`,
      ...relationship,
      analyzerVersion: "entity-v1",
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing({
      target: [
        relationships.fromNodeId,
        relationships.toNodeId,
        relationships.type,
        relationships.origin,
      ],
    });
  }
}

export async function rebuildCrossSourceRelationships(
  workspaceId: string,
  sourceId: string,
  db: SpecGraphDb = getDb(),
) {
  const groupId = await sourceGroupIdForSource(workspaceId, sourceId, db);
  if (!groupId) return;

  const memberIds = await sourceIdsForGroup(workspaceId, groupId, db);
  if (!memberIds.length) return;
  const members = await db
    .select({ id: sources.id, provider: sources.provider })
    .from(sources)
    .where(
      and(
        eq(sources.workspaceId, workspaceId),
        inArray(sources.id, memberIds),
      ),
    );
  const repositories = members.filter((member) => member.provider === "github");
  const documentationSources = members.filter(
    (member) => member.provider === "confluence",
  );

  for (const repository of repositories) {
    for (const documentation of documentationSources) {
      await rebuildPair(repository.id, documentation.id, db);
    }
  }
  await rebuildEntityRelationships(memberIds, db);
}
