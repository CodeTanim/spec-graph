import type { AnalysisArtifactKind, CandidateEdge } from "./candidates";

export const SEMANTIC_ANALYZER_VERSION = "semantic-contract-v1";
export const MAX_SEMANTIC_CANDIDATES = 12;
export const MAX_SEMANTIC_TEXT_CHARS = 6_000;
export const MIN_SEMANTIC_DISPLAY_CONFIDENCE = 0.78;

export type SemanticArtifactSnapshot = {
  nodeId: string;
  artifactId: string;
  kind: AnalysisArtifactKind;
  path: string;
  revision: string;
  sourceUrl: string | null;
  text: string;
};

export type SemanticCandidate = {
  id: string;
  artifact: SemanticArtifactSnapshot;
  lexicalScore: number;
  graphDistance: number | null;
  relationshipContext: Array<{
    type: string;
    origin: CandidateEdge["origin"];
    provenance: CandidateEdge["provenance"];
    confidence: number;
    evidence: string;
  }>;
};

export type SemanticAnalysisInput = {
  schemaVersion: "1";
  analyzerVersion: typeof SEMANTIC_ANALYZER_VERSION;
  runId: string;
  changed: SemanticArtifactSnapshot;
  candidates: SemanticCandidate[];
};

export type SemanticDecision = {
  candidateId: string;
  impact: boolean;
  confidence: number;
  summary: string;
  changedExcerpt: string | null;
  candidateExcerpt: string | null;
};

export type VerifiedSemanticDecision = SemanticDecision & {
  changedStartLine: number;
  candidateStartLine: number;
};

export type SemanticAnalyzer = {
  name: string;
  model: string;
  analyze(input: SemanticAnalysisInput): Promise<SemanticAnalyzerResult>;
};

export type SemanticAnalyzerResult = {
  output: unknown;
  usage: {
    promptTokens: number | null;
    completionTokens: number | null;
    estimatedCostMicros: number | null;
  };
};

export type SemanticExecution = {
  status: "succeeded" | "fallback";
  analyzerVersion: string;
  analyzerName: string | null;
  model: string | null;
  latencyMs: number;
  inputCandidateCount: number;
  outputDecisionCount: number;
  accepted: VerifiedSemanticDecision[];
  rejected: Array<{ candidateId: string | null; reason: string }>;
  failureReason: string | null;
  usage: SemanticAnalyzerResult["usage"];
};

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has",
  "in", "is", "it", "of", "on", "or", "that", "the", "this", "to", "was",
  "were", "will", "with",
]);

function tokens(text: string): Set<string> {
  const expanded = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return new Set(
    (expanded.match(/[a-z0-9_/.-]{3,}/g) || []).filter(
      (token) => !STOP_WORDS.has(token),
    ),
  );
}

export function lexicalSimilarity(leftText: string, rightText: string): number {
  const left = tokens(leftText);
  const right = tokens(rightText);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  if (!shared) return 0;
  return Number((shared / Math.sqrt(left.size * right.size)).toFixed(4));
}

function boundedSnapshot(snapshot: SemanticArtifactSnapshot): SemanticArtifactSnapshot {
  return {
    ...snapshot,
    text: snapshot.text.slice(0, MAX_SEMANTIC_TEXT_CHARS),
  };
}

export function generateSemanticCandidates(
  changed: SemanticArtifactSnapshot,
  candidates: SemanticArtifactSnapshot[],
  contexts: Map<string, { graphDistance: number | null; edges: CandidateEdge[] }> = new Map(),
): SemanticCandidate[] {
  return candidates
    .filter(
      (candidate) =>
        candidate.artifactId !== changed.artifactId &&
        candidate.nodeId !== changed.nodeId,
    )
    .map((candidate) => {
      const context = contexts.get(candidate.nodeId);
      return {
        id: candidate.nodeId,
        artifact: boundedSnapshot(candidate),
        lexicalScore: lexicalSimilarity(changed.text, candidate.text),
        graphDistance: context?.graphDistance ?? null,
        relationshipContext: (context?.edges || []).slice(0, 4).map((edge) => ({
          type: edge.type,
          origin: edge.origin,
          provenance: edge.provenance,
          confidence: edge.confidence,
          evidence: edge.evidence,
        })),
      };
    })
    .filter(
      (candidate) =>
        candidate.lexicalScore >= 0.12 || candidate.relationshipContext.length > 0,
    )
    .sort((left, right) =>
      right.relationshipContext.length - left.relationshipContext.length ||
      right.lexicalScore - left.lexicalScore ||
      left.id.localeCompare(right.id),
    )
    .slice(0, MAX_SEMANTIC_CANDIDATES);
}

export function buildSemanticAnalysisInput(
  runId: string,
  changed: SemanticArtifactSnapshot,
  candidates: SemanticCandidate[],
): SemanticAnalysisInput {
  return {
    schemaVersion: "1",
    analyzerVersion: SEMANTIC_ANALYZER_VERSION,
    runId,
    changed: boundedSnapshot(changed),
    candidates: candidates.slice(0, MAX_SEMANTIC_CANDIDATES),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(record: Record<string, unknown>, keys: string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(record).every((key) => allowed.has(key));
}

function exactExcerptLine(text: string, excerpt: string): number | null {
  const index = text.indexOf(excerpt);
  if (index < 0) return null;
  return text.slice(0, index).split("\n").length;
}

export function verifySemanticOutput(
  input: SemanticAnalysisInput,
  output: unknown,
): Pick<SemanticExecution, "accepted" | "rejected" | "outputDecisionCount"> {
  const accepted: VerifiedSemanticDecision[] = [];
  const rejected: SemanticExecution["rejected"] = [];
  if (
    !isRecord(output) ||
    !hasOnlyKeys(output, ["schemaVersion", "decisions"]) ||
    output.schemaVersion !== "1" ||
    !Array.isArray(output.decisions)
  ) {
    return {
      accepted,
      rejected: [{ candidateId: null, reason: "INVALID_OUTPUT_SCHEMA" }],
      outputDecisionCount: 0,
    };
  }

  const candidates = new Map(input.candidates.map((candidate) => [candidate.id, candidate]));
  const seen = new Set<string>();
  for (const value of output.decisions.slice(0, MAX_SEMANTIC_CANDIDATES)) {
    if (
      !isRecord(value) ||
      !hasOnlyKeys(value, [
        "candidateId",
        "impact",
        "confidence",
        "summary",
        "changedExcerpt",
        "candidateExcerpt",
      ])
    ) {
      rejected.push({ candidateId: null, reason: "INVALID_DECISION_SCHEMA" });
      continue;
    }
    const candidateId = typeof value.candidateId === "string" ? value.candidateId : null;
    const candidate = candidateId ? candidates.get(candidateId) : null;
    if (!candidateId || !candidate || seen.has(candidateId)) {
      rejected.push({ candidateId, reason: "UNKNOWN_OR_DUPLICATE_CANDIDATE" });
      continue;
    }
    seen.add(candidateId);
    if (
      typeof value.impact !== "boolean" ||
      typeof value.confidence !== "number" ||
      !Number.isFinite(value.confidence) ||
      value.confidence < 0 ||
      value.confidence > 1 ||
      typeof value.summary !== "string" ||
      !value.summary.trim() ||
      value.summary.length > 400
    ) {
      rejected.push({ candidateId, reason: "INVALID_DECISION_VALUES" });
      continue;
    }
    if (!value.impact || value.confidence < MIN_SEMANTIC_DISPLAY_CONFIDENCE) continue;
    if (
      typeof value.changedExcerpt !== "string" ||
      typeof value.candidateExcerpt !== "string" ||
      value.changedExcerpt.length < 4 ||
      value.candidateExcerpt.length < 4 ||
      value.changedExcerpt.length > 800 ||
      value.candidateExcerpt.length > 800
    ) {
      rejected.push({ candidateId, reason: "EVIDENCE_REQUIRED" });
      continue;
    }
    const changedStartLine = exactExcerptLine(input.changed.text, value.changedExcerpt);
    const candidateStartLine = exactExcerptLine(candidate.artifact.text, value.candidateExcerpt);
    if (changedStartLine === null || candidateStartLine === null) {
      rejected.push({ candidateId, reason: "UNVERIFIED_EVIDENCE" });
      continue;
    }
    accepted.push({
      candidateId,
      impact: true,
      confidence: value.confidence,
      summary: value.summary.trim(),
      changedExcerpt: value.changedExcerpt,
      candidateExcerpt: value.candidateExcerpt,
      changedStartLine,
      candidateStartLine,
    });
  }
  return { accepted, rejected, outputDecisionCount: output.decisions.length };
}

export function combinedSemanticConfidence(
  modelConfidence: number,
  candidate: SemanticCandidate,
): number {
  const boundedModel = Math.max(0, Math.min(1, modelConfidence));
  if (!candidate.relationshipContext.length || candidate.graphDistance === null) {
    return Number(
      (boundedModel * 0.85 + candidate.lexicalScore * 0.15).toFixed(4),
    );
  }
  const graphDistanceScore = candidate.graphDistance <= 1
    ? 1
    : candidate.graphDistance === 2
      ? 0.75
      : 0.5;
  const relationshipScore = Math.max(
    ...candidate.relationshipContext.map((relationship) => {
      const originWeight = relationship.origin === "deterministic"
        ? 1
        : relationship.origin === "hybrid"
          ? 0.95
          : 0.7;
      return relationship.confidence * originWeight;
    }),
  );
  return Number((
    boundedModel * 0.7 +
    candidate.lexicalScore * 0.1 +
    graphDistanceScore * 0.1 +
    relationshipScore * 0.1
  ).toFixed(4));
}

function rankVerifiedDecisions(
  input: SemanticAnalysisInput,
  verified: ReturnType<typeof verifySemanticOutput>,
): ReturnType<typeof verifySemanticOutput> {
  const candidateById = new Map(input.candidates.map((candidate) => [candidate.id, candidate]));
  const accepted: VerifiedSemanticDecision[] = [];
  const rejected = [...verified.rejected];
  for (const decision of verified.accepted) {
    const candidate = candidateById.get(decision.candidateId);
    if (!candidate) continue;
    const confidence = combinedSemanticConfidence(decision.confidence, candidate);
    if (confidence < MIN_SEMANTIC_DISPLAY_CONFIDENCE) {
      rejected.push({
        candidateId: decision.candidateId,
        reason: "LOW_COMBINED_CONFIDENCE",
      });
      continue;
    }
    accepted.push({ ...decision, confidence });
  }
  accepted.sort((left, right) =>
    right.confidence - left.confidence || left.candidateId.localeCompare(right.candidateId),
  );
  return { ...verified, accepted, rejected };
}

export async function executeSemanticAnalysis(
  input: SemanticAnalysisInput,
  analyzer?: SemanticAnalyzer,
): Promise<SemanticExecution> {
  const startedAt = Date.now();
  if (!analyzer) {
    return {
      status: "fallback",
      analyzerVersion: SEMANTIC_ANALYZER_VERSION,
      analyzerName: null,
      model: null,
      latencyMs: 0,
      inputCandidateCount: input.candidates.length,
      outputDecisionCount: 0,
      accepted: [],
      rejected: [],
      failureReason: "SEMANTIC_ANALYZER_NOT_CONFIGURED",
      usage: {
        promptTokens: null,
        completionTokens: null,
        estimatedCostMicros: null,
      },
    };
  }
  try {
    const result = await analyzer.analyze(input);
    const verified = rankVerifiedDecisions(
      input,
      verifySemanticOutput(input, result.output),
    );
    return {
      status: "succeeded",
      analyzerVersion: SEMANTIC_ANALYZER_VERSION,
      analyzerName: analyzer.name,
      model: analyzer.model,
      latencyMs: Date.now() - startedAt,
      inputCandidateCount: input.candidates.length,
      ...verified,
      failureReason: null,
      usage: result.usage,
    };
  } catch (error) {
    return {
      status: "fallback",
      analyzerVersion: SEMANTIC_ANALYZER_VERSION,
      analyzerName: analyzer.name,
      model: analyzer.model,
      latencyMs: Date.now() - startedAt,
      inputCandidateCount: input.candidates.length,
      outputDecisionCount: 0,
      accepted: [],
      rejected: [],
      failureReason: error instanceof Error ? error.message : "SEMANTIC_ANALYZER_FAILED",
      usage: {
        promptTokens: null,
        completionTokens: null,
        estimatedCostMicros: null,
      },
    };
  }
}
