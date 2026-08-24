export type AnalysisArtifactKind =
  | "code"
  | "test"
  | "markdown"
  | "openapi"
  | "confluence";

export type CandidateNode = {
  nodeId: string;
  artifactId: string;
  kind: AnalysisArtifactKind;
  path: string;
};

export type CandidateEdge = {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  type: string;
  origin: "deterministic" | "semantic" | "hybrid";
  confidence: number;
  evidence: string;
  evidenceStartLine: number | null;
};

export type CandidateChange = {
  id: string;
  path: string;
  changeKeys?: string[];
};

export type RankedCandidate = {
  changedNodeId: string;
  affectedNodeId: string;
  edge: CandidateEdge;
  path: CandidateEdge[];
  viaNodeIds: string[];
  depth: number;
  score: number;
  origin: "deterministic" | "semantic" | "hybrid";
};

const EDGE_WEIGHTS: Record<string, number> = {
  links: 1,
  documents: 0.98,
  references: 0.95,
  tests: 0.86,
  imports: 0.88,
};

function edgeWeight(type: string): number {
  if (type.startsWith("covers_openapi:") || type === "covers_endpoint") return 1;
  return EDGE_WEIGHTS[type] ?? 0.8;
}

function isDocumentation(kind: AnalysisArtifactKind): boolean {
  return kind === "markdown" || kind === "openapi" || kind === "confluence";
}

export function shouldCreateImpactFinding(
  changedKind: AnalysisArtifactKind,
  affectedKind: AnalysisArtifactKind,
): boolean {
  if (changedKind === "openapi") {
    return affectedKind === "markdown" || affectedKind === "confluence";
  }
  return isDocumentation(changedKind) || isDocumentation(affectedKind);
}

function pathMatchesOpenApiChange(
  path: CandidateEdge[],
  changeKeys: Set<string> | undefined,
): boolean {
  if (!changeKeys || changeKeys.has("document")) return true;
  return path.some((edge) => {
    if (!edge.type.startsWith("covers_openapi:")) return false;
    return changeKeys.has(edge.type.slice("covers_openapi:".length));
  });
}

function combinedOrigin(path: CandidateEdge[]): RankedCandidate["origin"] {
  if (path.some((edge) => edge.origin === "hybrid")) return "hybrid";
  const origins = new Set(path.map((edge) => edge.origin));
  return origins.size > 1 ? "hybrid" : path[0]?.origin || "deterministic";
}

function preferredEvidenceEdge(
  affectedNodeId: string,
  path: CandidateEdge[],
): CandidateEdge {
  return (
    [...path].reverse().find((edge) => edge.fromNodeId === affectedNodeId) ||
    path.at(-1)!
  );
}

export function rankDeterministicCandidates(
  changes: CandidateChange[],
  nodes: CandidateNode[],
  edges: CandidateEdge[],
  options: {
    maxDepth?: number;
    maxCandidates?: number;
    minimumScore?: number;
    maxVisitedPerChange?: number;
  } = {},
): RankedCandidate[] {
  const maxDepth = options.maxDepth ?? 2;
  const maxCandidates = options.maxCandidates ?? 25;
  const minimumScore = options.minimumScore ?? 0.7;
  const maxVisitedPerChange = options.maxVisitedPerChange ?? 250;
  const nodeById = new Map(nodes.map((node) => [node.nodeId, node]));
  const changedNodeIds = new Set(changes.map((change) => change.id));
  const adjacency = new Map<string, CandidateEdge[]>();
  for (const edge of edges) {
    if (!nodeById.has(edge.fromNodeId) || !nodeById.has(edge.toNodeId)) continue;
    adjacency.set(edge.fromNodeId, [...(adjacency.get(edge.fromNodeId) || []), edge]);
    adjacency.set(edge.toNodeId, [...(adjacency.get(edge.toNodeId) || []), edge]);
  }

  const ranked = new Map<string, RankedCandidate>();
  for (const change of changes) {
    const changedNode = nodeById.get(change.id);
    if (!changedNode) continue;
    const changeKeys = change.changeKeys?.length
      ? new Set(change.changeKeys)
      : undefined;
    const queue: Array<{
      nodeId: string;
      path: CandidateEdge[];
      nodePath: string[];
      visited: Set<string>;
      score: number;
    }> = [{
      nodeId: change.id,
      path: [],
      nodePath: [change.id],
      visited: new Set([change.id]),
      score: 1,
    }];
    let visitedCount = 0;

    while (queue.length && visitedCount < maxVisitedPerChange) {
      const current = queue.shift()!;
      if (current.path.length >= maxDepth) continue;
      for (const edge of adjacency.get(current.nodeId) || []) {
        const nextNodeId =
          edge.fromNodeId === current.nodeId ? edge.toNodeId : edge.fromNodeId;
        if (current.visited.has(nextNodeId)) continue;
        const nextNode = nodeById.get(nextNodeId);
        if (!nextNode) continue;
        visitedCount += 1;

        const depth = current.path.length + 1;
        const path = [...current.path, edge];
        const nodePath = [...current.nodePath, nextNodeId];
        const score =
          current.score *
          edgeWeight(edge.type) *
          Math.max(0, Math.min(1, edge.confidence)) *
          (depth === 1 ? 1 : 0.86);
        const eligible =
          !changedNodeIds.has(nextNodeId) &&
          nextNode.artifactId !== changedNode.artifactId &&
          shouldCreateImpactFinding(changedNode.kind, nextNode.kind) &&
          !(
            depth > 1 &&
            isDocumentation(changedNode.kind) &&
            !isDocumentation(nextNode.kind)
          ) &&
          pathMatchesOpenApiChange(path, changeKeys);

        if (eligible && score >= minimumScore) {
          const candidate: RankedCandidate = {
            changedNodeId: change.id,
            affectedNodeId: nextNodeId,
            edge: preferredEvidenceEdge(nextNodeId, path),
            path,
            viaNodeIds: nodePath.slice(1, -1),
            depth,
            score: Number(score.toFixed(4)),
            origin: combinedOrigin(path),
          };
          const key = `${change.id}:${nextNode.artifactId}`;
          const existing = ranked.get(key);
          if (
            !existing ||
            candidate.score > existing.score ||
            (candidate.score === existing.score && candidate.depth < existing.depth)
          ) {
            ranked.set(key, candidate);
          }
        }

        const reachedDocumentation = isDocumentation(nextNode.kind);
        const stopAtDocumentation =
          reachedDocumentation &&
          (changedNode.kind === "code" ||
            changedNode.kind === "test" ||
            changedNode.kind === "openapi");
        if (!stopAtDocumentation && depth < maxDepth && score >= minimumScore) {
          queue.push({
            nodeId: nextNodeId,
            path,
            nodePath,
            visited: new Set([...current.visited, nextNodeId]),
            score,
          });
        }
      }
    }
  }

  return [...ranked.values()]
    .sort((left, right) =>
      right.score - left.score ||
      left.depth - right.depth ||
      left.affectedNodeId.localeCompare(right.affectedNodeId),
    )
    .slice(0, maxCandidates);
}
