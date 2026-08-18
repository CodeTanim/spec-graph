import { and, desc, eq, inArray, or } from "drizzle-orm";
import { getDb, type SpecGraphDb } from "../../db";
import {
  artifacts,
  artifactVersions,
  findingEvidence,
  findings,
  graphNodes,
  relationships,
  sources,
} from "../../db/schema";

export type ChangedGraphNode = {
  id: string;
  path: string;
};

function evidenceExcerpt(content: string, startLine: number): string {
  const lines = content.split("\n").slice(Math.max(0, startLine - 1), startLine + 3);
  const excerpt = lines.join("\n").trim();
  return excerpt || "The indexed artifact is empty.";
}

function evidenceUrl(
  kind: "code" | "test" | "markdown" | "openapi" | "confluence",
  url: string | null,
  startLine: number,
  endLine: number,
): string | null {
  if (!url || kind === "confluence") return url;
  return `${url}#L${startLine}-L${endLine}`;
}

function relationshipReason(type: string, changedPath: string): string {
  switch (type) {
    case "imports":
      return `It is connected to ${changedPath} through a code import.`;
    case "links":
      return `It is connected to ${changedPath} through a documentation link.`;
    case "covers_endpoint":
      return `It shares an API endpoint with ${changedPath}.`;
    case "documents":
      return `It is connected to ${changedPath} through an explicit documentation reference.`;
    default:
      return `It explicitly references ${changedPath}.`;
  }
}

export async function persistDeterministicFindings(
  workspaceId: string,
  runId: string,
  changedNodes: ChangedGraphNode[],
  db: SpecGraphDb = getDb(),
): Promise<number> {
  if (!changedNodes.length) return 0;

  const changedNodeIds = changedNodes.map((node) => node.id);
  const changedPathByNode = new Map(changedNodes.map((node) => [node.id, node.path]));
  const edges = await db
    .select()
    .from(relationships)
    .where(
      or(
        inArray(relationships.fromNodeId, changedNodeIds),
        inArray(relationships.toNodeId, changedNodeIds),
      ),
    );
  const affectedNodeIds = [
    ...new Set(
      edges
        .map((edge) =>
          changedPathByNode.has(edge.fromNodeId) ? edge.toNodeId : edge.fromNodeId,
        )
        .filter((id) => !changedPathByNode.has(id)),
    ),
  ];
  if (!affectedNodeIds.length) return 0;

  const affectedRecords = await db
    .select({
      nodeId: graphNodes.id,
      artifactId: artifacts.id,
      kind: artifacts.kind,
      title: artifacts.title,
      path: artifacts.path,
      currentRevision: artifacts.currentRevision,
      canonicalUrl: artifacts.canonicalUrl,
      startLine: graphNodes.startLine,
      endLine: graphNodes.endLine,
    })
    .from(graphNodes)
    .innerJoin(artifacts, eq(graphNodes.artifactId, artifacts.id))
    .innerJoin(sources, eq(artifacts.sourceId, sources.id))
    .where(
      and(
        eq(sources.workspaceId, workspaceId),
        inArray(graphNodes.id, affectedNodeIds),
      ),
    );
  const affectedByNode = new Map(affectedRecords.map((record) => [record.nodeId, record]));
  const persisted = new Set<string>();
  const now = new Date().toISOString();

  for (const edge of edges) {
    const changedNodeId = changedPathByNode.has(edge.fromNodeId)
      ? edge.fromNodeId
      : edge.toNodeId;
    const affectedNodeId = changedNodeId === edge.fromNodeId ? edge.toNodeId : edge.fromNodeId;
    const affected = affectedByNode.get(affectedNodeId);
    if (!affected || persisted.has(affectedNodeId)) continue;
    persisted.add(affectedNodeId);

    const versions = await db
      .select()
      .from(artifactVersions)
      .where(eq(artifactVersions.artifactId, affected.artifactId))
      .orderBy(desc(artifactVersions.createdAt));
    const version =
      versions.find((item) => item.revision === affected.currentRevision) || versions[0];
    const startLine = Math.max(1, affected.startLine || 1);
    const endLine = Math.max(startLine, Math.min(affected.endLine || startLine + 3, startLine + 3));
    const changedPath = changedPathByNode.get(changedNodeId) || "the changed item";
    const findingId = `finding_${crypto.randomUUID()}`;

    await db.insert(findings).values({
      id: findingId,
      runId,
      changedNodeId,
      affectedNodeId,
      title: affected.title,
      summary: relationshipReason(edge.type, changedPath),
      confidence: edge.confidence,
      origin: edge.origin,
      status: "open",
      deduplicationKey: `${changedNodeId}:${affectedNodeId}:${edge.type}`,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(findingEvidence).values({
      id: `evidence_${crypto.randomUUID()}`,
      findingId,
      artifactVersionId: version?.id || null,
      location: `${affected.path}:${startLine}`,
      startLine,
      endLine,
      excerpt: version ? evidenceExcerpt(version.extractedText, startLine) : edge.evidence,
      sourceUrl: evidenceUrl(
        affected.kind,
        affected.canonicalUrl,
        startLine,
        endLine,
      ),
      type: "relationship",
      createdAt: now,
    });
  }

  return persisted.size;
}
