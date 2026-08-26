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
    })
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

  const openApiArtifacts = repositoryNodes.filter((item) => item.kind === "openapi");
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
    for (const repository of repositoryNodes) {
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

export async function rebuildCrossSourceRelationships(
  workspaceId: string,
  sourceId: string,
  db: SpecGraphDb = getDb(),
) {
  const groupId = await sourceGroupIdForSource(workspaceId, sourceId, db);
  if (!groupId) return;

  const memberIds = await sourceIdsForGroup(workspaceId, groupId, db);
  if (memberIds.length < 2) return;
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
}
