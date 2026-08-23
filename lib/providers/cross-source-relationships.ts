import { and, eq, inArray, or } from "drizzle-orm";
import { getDb, type SpecGraphDb } from "../../db";
import {
  artifacts,
  artifactVersions,
  graphNodes,
  relationships,
  sourceAssociations,
} from "../../db/schema";

async function rebuildPair(
  repositorySourceId: string,
  documentationSourceId: string,
  db: SpecGraphDb,
) {
  const repositoryNodes = await db
    .select({ nodeId: graphNodes.id, path: artifacts.path })
    .from(graphNodes)
    .innerJoin(artifacts, eq(graphNodes.artifactId, artifacts.id))
    .where(eq(artifacts.sourceId, repositorySourceId));
  const documentationNodes = await db
    .select({
      nodeId: graphNodes.id,
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
    .where(eq(artifacts.sourceId, documentationSourceId));

  const repositoryNodeIds = repositoryNodes.map((item) => item.nodeId);
  const documentationNodeIds = documentationNodes.map((item) => item.nodeId);
  if (repositoryNodeIds.length && documentationNodeIds.length) {
    await db.delete(relationships).where(and(
      eq(relationships.type, "documents"),
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

  const now = new Date().toISOString();
  for (const documentation of documentationNodes) {
    for (const repository of repositoryNodes) {
      if (!documentation.text.includes(repository.path)) continue;
      const evidenceLines = documentation.text.split("\n");
      const evidenceIndex = evidenceLines.findIndex((line) =>
        line.includes(repository.path),
      );
      await db.insert(relationships).values({
        id: `rel_${crypto.randomUUID()}`,
        fromNodeId: documentation.nodeId,
        toNodeId: repository.nodeId,
        type: "documents",
        origin: "deterministic",
        confidence: 1,
        evidence:
          evidenceLines[evidenceIndex]?.trim() ||
          `Confluence page references ${repository.path}`,
        evidenceStartLine: evidenceIndex >= 0 ? evidenceIndex + 1 : 1,
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

export async function rebuildCrossSourceRelationships(
  workspaceId: string,
  sourceId: string,
  db: SpecGraphDb = getDb(),
) {
  const associations = await db.select().from(sourceAssociations).where(and(
    eq(sourceAssociations.workspaceId, workspaceId),
    or(
      eq(sourceAssociations.repositorySourceId, sourceId),
      eq(sourceAssociations.documentationSourceId, sourceId),
    ),
  ));
  for (const association of associations) {
    await rebuildPair(
      association.repositorySourceId,
      association.documentationSourceId,
      db,
    );
  }
}
