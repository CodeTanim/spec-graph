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

type IndexedArtifactKind =
  | "code"
  | "test"
  | "markdown"
  | "openapi"
  | "confluence";

function isDocumentation(kind: IndexedArtifactKind): boolean {
  return kind === "markdown" || kind === "openapi" || kind === "confluence";
}

export function shouldCreateImpactFinding(
  changedKind: IndexedArtifactKind,
  affectedKind: IndexedArtifactKind,
): boolean {
  return isDocumentation(changedKind) || isDocumentation(affectedKind);
}

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

function artifactNoun(kind: IndexedArtifactKind): "file" | "page" {
  return kind === "confluence" ? "page" : "file";
}

export function relationshipReason(
  type: string,
  changedPath: string,
  changedKind: IndexedArtifactKind,
  affectedKind: IndexedArtifactKind,
  changedIsFrom: boolean,
): string {
  const changedNoun = artifactNoun(changedKind);
  const affectedNoun = artifactNoun(affectedKind);
  if (type === "covers_endpoint") {
    return `This ${affectedNoun} shares an API endpoint with the changed ${changedNoun} ${changedPath}.`;
  }
  if (changedIsFrom) {
    const verb = type === "links" ? "links to" : "references";
    return `The changed ${changedNoun} ${changedPath} ${verb} this ${affectedNoun}.`;
  }
  const verb = type === "links" ? "links to" : "references";
  return `This ${affectedNoun} ${verb} the changed ${changedNoun} ${changedPath}.`;
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
  const changedRecords = await db
    .select({
      nodeId: graphNodes.id,
      artifactId: artifacts.id,
      kind: artifacts.kind,
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
        inArray(graphNodes.id, changedNodeIds),
      ),
    );
  const changedKindByNode = new Map(
    changedRecords.map((record) => [record.nodeId, record.kind]),
  );
  const changedRecordByNode = new Map(
    changedRecords.map((record) => [record.nodeId, record]),
  );
  const validChangedNodeIds = [...changedKindByNode.keys()];
  if (!validChangedNodeIds.length) return 0;

  const edges = await db
    .select()
    .from(relationships)
    .where(
      or(
        inArray(relationships.fromNodeId, validChangedNodeIds),
        inArray(relationships.toNodeId, validChangedNodeIds),
      ),
    );
  const candidates = edges.flatMap((edge) => {
    const fromChanged = changedKindByNode.has(edge.fromNodeId);
    const toChanged = changedKindByNode.has(edge.toNodeId);
    if (fromChanged === toChanged) return [];

    return [
      fromChanged
        ? {
            edge,
            changedNodeId: edge.fromNodeId,
            affectedNodeId: edge.toNodeId,
          }
        : {
            edge,
            changedNodeId: edge.toNodeId,
            affectedNodeId: edge.fromNodeId,
          },
    ];
  });
  const affectedNodeIds = [
    ...new Set(candidates.map((candidate) => candidate.affectedNodeId)),
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
  const recordByNode = new Map([
    ...changedRecordByNode.entries(),
    ...affectedByNode.entries(),
  ]);
  const persisted = new Set<string>();
  const now = new Date().toISOString();

  for (const { edge, changedNodeId, affectedNodeId } of candidates) {
    const affected = affectedByNode.get(affectedNodeId);
    const changedKind = changedKindByNode.get(changedNodeId);
    if (
      !affected ||
      !changedKind ||
      !shouldCreateImpactFinding(changedKind, affected.kind) ||
      persisted.has(affectedNodeId)
    ) {
      continue;
    }
    persisted.add(affectedNodeId);

    const evidenceRecord = recordByNode.get(edge.fromNodeId);
    const versions = await db
      .select()
      .from(artifactVersions)
      .where(
        eq(
          artifactVersions.artifactId,
          evidenceRecord?.artifactId || affected.artifactId,
        ),
      )
      .orderBy(desc(artifactVersions.createdAt));
    const version =
      versions.find(
        (item) => item.revision === evidenceRecord?.currentRevision,
      ) || versions[0];
    const startLine = Math.max(
      1,
      edge.evidenceStartLine || evidenceRecord?.startLine || 1,
    );
    const endLine = Math.max(startLine, startLine + 3);
    const changedPath = changedPathByNode.get(changedNodeId) || "the changed item";
    const findingId = `finding_${crypto.randomUUID()}`;

    await db.insert(findings).values({
      id: findingId,
      runId,
      changedNodeId,
      affectedNodeId,
      title: affected.title,
      summary: relationshipReason(
        edge.type,
        changedPath,
        changedKind,
        affected.kind,
        edge.fromNodeId === changedNodeId,
      ),
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
      location: `${evidenceRecord?.path || affected.path}:${startLine}`,
      startLine,
      endLine,
      excerpt: version
        ? evidenceExcerpt(version.extractedText, startLine)
        : edge.evidence,
      sourceUrl: evidenceUrl(
        evidenceRecord?.kind || affected.kind,
        evidenceRecord?.canonicalUrl || affected.canonicalUrl,
        startLine,
        endLine,
      ),
      type: "relationship",
      createdAt: now,
    });
  }

  return persisted.size;
}
