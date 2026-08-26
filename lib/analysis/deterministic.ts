import { and, desc, eq, inArray } from "drizzle-orm";
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
import { sha256Hex } from "../github/crypto";
import { sourceIdsConnectedTo } from "../providers/source-groups";
import {
  rankDeterministicCandidates,
  type AnalysisArtifactKind,
  type CandidateEdge,
} from "./candidates";

export { shouldCreateImpactFinding } from "./candidates";

export type ChangedGraphNode = {
  id: string;
  path: string;
  changeSummary?: string;
  changeKeys?: string[];
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

function artifactNoun(kind: AnalysisArtifactKind): "file" | "page" {
  return kind === "confluence" ? "page" : "file";
}

export function relationshipReason(
  type: string,
  changedPath: string,
  changedKind: AnalysisArtifactKind,
  affectedKind: AnalysisArtifactKind,
  changedIsFrom: boolean,
): string {
  const changedNoun = artifactNoun(changedKind);
  const affectedNoun = artifactNoun(affectedKind);
  if (type.startsWith("covers_openapi:") || type === "covers_endpoint") {
    return changedKind === "openapi"
      ? `This ${affectedNoun} references the changed API contract in ${changedPath}.`
      : `This ${affectedNoun} shares an API contract reference with the changed ${changedNoun} ${changedPath}.`;
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
  const changedSummaryByNode = new Map(
    changedNodes.flatMap((node) =>
      node.changeSummary ? [[node.id, node.changeSummary] as const] : [],
    ),
  );
  const allWorkspaceRecords = await db
    .select({
      nodeId: graphNodes.id,
      artifactId: artifacts.id,
      sourceId: artifacts.sourceId,
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
      eq(sources.workspaceId, workspaceId),
    );
  const changedRecordsAcrossWorkspace = allWorkspaceRecords.filter((record) =>
    changedNodeIds.includes(record.nodeId),
  );
  const allowedSourceIds = new Set(
    await sourceIdsConnectedTo(
      workspaceId,
      changedRecordsAcrossWorkspace.map((record) => record.sourceId),
      db,
    ),
  );
  const workspaceRecords = allWorkspaceRecords.filter((record) =>
    allowedSourceIds.has(record.sourceId),
  );
  const workspaceNodeIds = new Set(workspaceRecords.map((record) => record.nodeId));
  const changedRecords = workspaceRecords.filter((record) =>
    changedNodeIds.includes(record.nodeId),
  );
  const changedKindByNode = new Map(
    changedRecords.map((record) => [record.nodeId, record.kind]),
  );
  const changedRecordByNode = new Map(
    changedRecords.map((record) => [record.nodeId, record]),
  );
  const validChangedNodeIds = [...changedKindByNode.keys()];
  if (!validChangedNodeIds.length) return 0;

  const edges: CandidateEdge[] = [];
  const workspaceNodeIdList = [...workspaceNodeIds];
  for (let index = 0; index < workspaceNodeIdList.length; index += 40) {
    const records = await db
      .select()
      .from(relationships)
      .where(inArray(relationships.fromNodeId, workspaceNodeIdList.slice(index, index + 40)));
    for (const record of records) {
      if (workspaceNodeIds.has(record.toNodeId)) edges.push(record);
    }
  }
  const candidates = rankDeterministicCandidates(
    changedNodes.filter((node) => changedKindByNode.has(node.id)),
    workspaceRecords.map((record) => ({
      nodeId: record.nodeId,
      artifactId: record.artifactId,
      kind: record.kind,
      path: record.path,
    })),
    edges,
  );
  if (!candidates.length) return 0;

  const affectedNodeIds = new Set(candidates.map((candidate) => candidate.affectedNodeId));
  const affectedRecords = workspaceRecords.filter((record) =>
    affectedNodeIds.has(record.nodeId),
  );
  const affectedByNode = new Map(affectedRecords.map((record) => [record.nodeId, record]));
  const recordByNode = new Map([
    ...changedRecordByNode.entries(),
    ...affectedByNode.entries(),
  ]);
  const persistedArtifacts = new Set<string>();
  const now = new Date().toISOString();

  for (const candidate of candidates) {
    const { edge, changedNodeId, affectedNodeId } = candidate;
    const affected = affectedByNode.get(affectedNodeId);
    const changedKind = changedKindByNode.get(changedNodeId);
    if (
      !affected ||
      !changedKind ||
      persistedArtifacts.has(affected.artifactId)
    ) {
      continue;
    }
    persistedArtifacts.add(affected.artifactId);

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
    const relationshipSummary = candidate.depth === 1
      ? relationshipReason(
          edge.type,
          changedPath,
          changedKind,
          affected.kind,
          edge.fromNodeId === changedNodeId,
        )
      : `This ${artifactNoun(affected.kind)} is connected to the changed ${artifactNoun(changedKind)} ${changedPath} through ${candidate.depth} verified relationship steps.`;
    const changeSummary = changedSummaryByNode.get(changedNodeId);
    const deduplicationKey = `${changedNodeId}:${affected.artifactId}:${candidate.path.map((item) => item.type).join(">")}`;
    const stableSuffix = (await sha256Hex(`${runId}:${deduplicationKey}`)).slice(0, 32);
    const inserted = await db.insert(findings).values({
      id: `finding_${stableSuffix}`,
      runId,
      changedNodeId,
      affectedNodeId,
      title: affected.title,
      summary: changeSummary
        ? `${changeSummary} ${relationshipSummary}`
        : relationshipSummary,
      confidence: candidate.score,
      origin: candidate.origin,
      provenance: edge.provenance || "LEGACY",
      analyzerVersion: edge.analyzerVersion || "deterministic-v1",
      status: "open",
      deduplicationKey,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing({
      target: [findings.runId, findings.deduplicationKey],
    }).returning({ id: findings.id });
    const [existingFinding] = inserted.length
      ? inserted
      : await db
          .select({ id: findings.id })
          .from(findings)
          .where(and(
            eq(findings.runId, runId),
            eq(findings.deduplicationKey, deduplicationKey),
          ))
          .limit(1);
    if (!existingFinding) continue;
    await db.insert(findingEvidence).values({
      id: `evidence_${stableSuffix}`,
      findingId: existingFinding.id,
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
    }).onConflictDoNothing({ target: findingEvidence.id });
  }

  return persistedArtifacts.size;
}
