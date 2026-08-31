import type { AnalysisArtifactKind, CandidateEdge } from "./candidates";

export const SEMANTIC_ANALYZER_VERSION = "semantic-contract-v1";
export const SEMANTIC_RETRIEVAL_VERSION = "section-aware-lexical-v1";
// Retrieval is deliberately narrow: the reviewed evaluation package keeps
// every expected target in the top three, so sending lower-ranked lexical
// neighbors only adds cost and false-positive opportunities.
export const MAX_SEMANTIC_CANDIDATES = 3;
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
  decisionBasis?: string;
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
  /** Version of the provider-specific prompt/calibration layered on the contract. */
  version?: string;
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

export type SemanticCandidateDisposition =
  | "ACCEPTED"
  | "MODEL_NEGATIVE"
  | "MODEL_CONFIDENCE_BELOW_THRESHOLD"
  | "EVIDENCE_REQUIRED"
  | "EVIDENCE_UNVERIFIED"
  | "COMBINED_CONFIDENCE_BELOW_THRESHOLD"
  | "MISSING_DECISION"
  | "INVALID_DECISION"
  | "OUTPUT_SCHEMA_INVALID"
  | "ANALYZER_FALLBACK";

export type SemanticCandidateDecisionTrace = {
  candidateId: string;
  modelImpact: boolean | null;
  modelConfidence: number | null;
  modelDecisionBasis?: string | null;
  evidenceStatus: "NOT_REQUESTED" | "VERIFIED" | "MISSING" | "UNVERIFIED";
  combinedConfidence: number | null;
  disposition: SemanticCandidateDisposition;
};

export type SemanticExecutionOptions = {
  traceDecisions?: boolean;
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
  decisionTrace?: SemanticCandidateDecisionTrace[];
  failureReason: string | null;
  usage: SemanticAnalyzerResult["usage"];
};

type SemanticVerificationResult = Pick<
  SemanticExecution,
  "accepted" | "rejected" | "outputDecisionCount" | "decisionTrace"
>;

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has",
  "in", "is", "it", "of", "on", "or", "that", "the", "this", "to", "was",
  "were", "will", "with",
]);

function canonicalToken(token: string): string {
  if (token === "max" || token === "maximum") {
    return "limit";
  }
  if (token.length > 5 && token.endsWith("ies")) {
    return `${token.slice(0, -3)}y`;
  }
  if (token.length > 6 && token.endsWith("ation")) {
    return token.slice(0, -5);
  }
  if (token.length > 5 && token.endsWith("ing")) {
    return token.slice(0, -3);
  }
  if (token.length > 4 && token.endsWith("ed")) {
    return token.slice(0, -2);
  }
  if (
    token.length > 4 &&
    (token.endsWith("ize") || token.endsWith("ve"))
  ) {
    return token.slice(0, -1);
  }
  if (
    token.length > 4 &&
    token.endsWith("s") &&
    !token.endsWith("ss") &&
    !token.endsWith("us") &&
    !token.endsWith("is")
  ) {
    return token.slice(0, -1);
  }
  return token;
}

function tokens(text: string): Set<string> {
  const expanded = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .toLowerCase();
  return new Set(
    (expanded.match(/[a-z0-9]{3,}/g) || [])
      .map(canonicalToken)
      .filter((token) => !STOP_WORDS.has(token)),
  );
}

function tokenSetSimilarity(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  if (!shared) return 0;
  return Number((shared / Math.sqrt(left.size * right.size)).toFixed(4));
}

export function lexicalSimilarity(leftText: string, rightText: string): number {
  return tokenSetSimilarity(tokens(leftText), tokens(rightText));
}

function semanticSegments(text: string): Set<string>[] {
  const bounded = text.slice(0, MAX_SEMANTIC_TEXT_CHARS);
  const blocks = bounded
    .split(/\n\s*\n/g)
    .map((value) => value.trim())
    .filter((value) => value.length >= 12);
  const lines = bounded
    .split("\n")
    .map((value) => value.trim())
    .filter((value) => value.length >= 20);
  const combined: string[] = [bounded, ...blocks, ...lines];
  for (let index = 0; index < blocks.length - 1; index += 1) {
    if (/^#{1,6}\s/.test(blocks[index]!)) {
      combined.push(`${blocks[index]}\n${blocks[index + 1]}`);
    }
  }
  const unique = [...new Set(combined)].slice(0, 32);
  return unique.map(tokens).filter((value) => value.size >= 3);
}

export function sectionAwareLexicalSimilarity(
  leftText: string,
  rightText: string,
): number {
  return sectionAwareTokenSimilarity(
    semanticSegments(leftText),
    semanticSegments(rightText),
  );
}

function sectionAwareTokenSimilarity(
  leftSegments: Set<string>[],
  rightSegments: Set<string>[],
): number {
  let strongest = 0;
  for (const left of leftSegments) {
    for (const right of rightSegments) {
      strongest = Math.max(strongest, tokenSetSimilarity(left, right));
    }
  }
  return strongest;
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
  const changedSegments = semanticSegments(changed.text);
  return candidates
    .filter(
      (candidate) =>
        candidate.artifactId !== changed.artifactId &&
        candidate.nodeId !== changed.nodeId &&
        // Documentation changes should point reviewers at the production
        // implementation that owns the behavior. Tests remain supporting
        // review context instead of becoming separate feed suggestions.
        !(
          ["markdown", "openapi", "confluence"].includes(changed.kind) &&
          candidate.kind === "test"
        ),
    )
    .map((candidate) => {
      const context = contexts.get(candidate.nodeId);
      return {
        id: candidate.nodeId,
        artifact: boundedSnapshot(candidate),
        lexicalScore: sectionAwareTokenSimilarity(
          changedSegments,
          semanticSegments(candidate.text),
        ),
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

type VerifiedExcerpt = {
  excerpt: string;
  startLine: number;
};

function excerptAt(text: string, index: number, length: number): VerifiedExcerpt {
  return {
    excerpt: text.slice(index, index + length),
    startLine: text.slice(0, index).split("\n").length,
  };
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function verifiedExcerpt(text: string, excerpt: string): VerifiedExcerpt | null {
  const exactIndex = text.indexOf(excerpt);
  if (exactIndex >= 0) return excerptAt(text, exactIndex, excerpt.length);

  // Structured-output models occasionally normalize a copied line break,
  // indentation, or tab to a regular space. Permit only that formatting
  // difference, then recover the byte-exact slice from the indexed revision
  // so persisted and displayed evidence still comes from the source itself.
  const fragments = excerpt.trim().split(/\s+/u).filter(Boolean);
  if (!fragments.length) return null;
  const match = new RegExp(
    fragments.map(escapeRegularExpression).join("\\s+"),
    "u",
  ).exec(text);
  if (!match || match.index === undefined) return null;
  return excerptAt(text, match.index, match[0].length);
}

export function verifySemanticOutput(
  input: SemanticAnalysisInput,
  output: unknown,
  options: SemanticExecutionOptions = {},
): SemanticVerificationResult {
  const accepted: VerifiedSemanticDecision[] = [];
  const rejected: SemanticExecution["rejected"] = [];
  const traceByCandidateId = options.traceDecisions
    ? new Map<string, SemanticCandidateDecisionTrace>(
        input.candidates.map((candidate) => [candidate.id, {
          candidateId: candidate.id,
          modelImpact: null,
          modelConfidence: null,
          evidenceStatus: "NOT_REQUESTED",
          combinedConfidence: null,
          disposition: "MISSING_DECISION",
        }]),
      )
    : null;
  const decisionTrace = (): SemanticCandidateDecisionTrace[] | undefined =>
    traceByCandidateId
      ? input.candidates.map((candidate) => traceByCandidateId.get(candidate.id)!)
      : undefined;
  const updateTrace = (
    candidateId: string,
    value: Omit<SemanticCandidateDecisionTrace, "candidateId">,
  ): void => {
    if (!traceByCandidateId?.has(candidateId)) return;
    traceByCandidateId.set(candidateId, { candidateId, ...value });
  };
  if (
    !isRecord(output) ||
    !hasOnlyKeys(output, ["schemaVersion", "decisions"]) ||
    output.schemaVersion !== "1" ||
    !Array.isArray(output.decisions)
  ) {
    if (traceByCandidateId) {
      for (const candidate of input.candidates) {
        updateTrace(candidate.id, {
          modelImpact: null,
          modelConfidence: null,
          evidenceStatus: "NOT_REQUESTED",
          combinedConfidence: null,
          disposition: "OUTPUT_SCHEMA_INVALID",
        });
      }
    }
    return {
      accepted,
      rejected: [{ candidateId: null, reason: "INVALID_OUTPUT_SCHEMA" }],
      outputDecisionCount: 0,
      decisionTrace: decisionTrace(),
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
        "decisionBasis",
        "changedExcerpt",
        "candidateExcerpt",
      ])
    ) {
      const invalidCandidateId = isRecord(value) && typeof value.candidateId === "string"
        ? value.candidateId
        : null;
      if (invalidCandidateId && candidates.has(invalidCandidateId) && !seen.has(invalidCandidateId)) {
        seen.add(invalidCandidateId);
        updateTrace(invalidCandidateId, {
          modelImpact: null,
          modelConfidence: null,
          evidenceStatus: "NOT_REQUESTED",
          combinedConfidence: null,
          disposition: "INVALID_DECISION",
        });
      }
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
      value.summary.length > 180
    ) {
      updateTrace(candidateId, {
        modelImpact: typeof value.impact === "boolean" ? value.impact : null,
        modelConfidence: typeof value.confidence === "number" && Number.isFinite(value.confidence)
          ? value.confidence
          : null,
        evidenceStatus: "NOT_REQUESTED",
        combinedConfidence: null,
        disposition: "INVALID_DECISION",
      });
      rejected.push({ candidateId, reason: "INVALID_DECISION_VALUES" });
      continue;
    }
    if (!value.impact) {
      updateTrace(candidateId, {
        modelImpact: false,
        modelConfidence: value.confidence,
        modelDecisionBasis: typeof value.decisionBasis === "string"
          ? value.decisionBasis
          : null,
        evidenceStatus: "NOT_REQUESTED",
        combinedConfidence: null,
        disposition: "MODEL_NEGATIVE",
      });
      continue;
    }
    if (value.confidence < MIN_SEMANTIC_DISPLAY_CONFIDENCE) {
      updateTrace(candidateId, {
        modelImpact: true,
        modelConfidence: value.confidence,
        evidenceStatus: "NOT_REQUESTED",
        combinedConfidence: null,
        disposition: "MODEL_CONFIDENCE_BELOW_THRESHOLD",
      });
      continue;
    }
    if (
      typeof value.changedExcerpt !== "string" ||
      typeof value.candidateExcerpt !== "string" ||
      value.changedExcerpt.length < 4 ||
      value.candidateExcerpt.length < 4 ||
      value.changedExcerpt.length > 800 ||
      value.candidateExcerpt.length > 800
    ) {
      updateTrace(candidateId, {
        modelImpact: true,
        modelConfidence: value.confidence,
        evidenceStatus: "MISSING",
        combinedConfidence: null,
        disposition: "EVIDENCE_REQUIRED",
      });
      rejected.push({ candidateId, reason: "EVIDENCE_REQUIRED" });
      continue;
    }
    const changedEvidence = verifiedExcerpt(input.changed.text, value.changedExcerpt);
    const candidateEvidence = verifiedExcerpt(
      candidate.artifact.text,
      value.candidateExcerpt,
    );
    if (!changedEvidence || !candidateEvidence) {
      updateTrace(candidateId, {
        modelImpact: true,
        modelConfidence: value.confidence,
        evidenceStatus: "UNVERIFIED",
        combinedConfidence: null,
        disposition: "EVIDENCE_UNVERIFIED",
      });
      rejected.push({ candidateId, reason: "UNVERIFIED_EVIDENCE" });
      continue;
    }
    updateTrace(candidateId, {
      modelImpact: true,
      modelConfidence: value.confidence,
      modelDecisionBasis: typeof value.decisionBasis === "string"
        ? value.decisionBasis
        : null,
      evidenceStatus: "VERIFIED",
      combinedConfidence: null,
      disposition: "ACCEPTED",
    });
    accepted.push({
      candidateId,
      impact: true,
      confidence: value.confidence,
      summary: value.summary.trim(),
      decisionBasis: typeof value.decisionBasis === "string"
        ? value.decisionBasis
        : undefined,
      changedExcerpt: changedEvidence.excerpt,
      candidateExcerpt: candidateEvidence.excerpt,
      changedStartLine: changedEvidence.startLine,
      candidateStartLine: candidateEvidence.startLine,
    });
  }
  return {
    accepted,
    rejected,
    outputDecisionCount: output.decisions.length,
    decisionTrace: decisionTrace(),
  };
}

export function combinedSemanticConfidence(
  modelConfidence: number,
  candidate: SemanticCandidate,
): number {
  const boundedModel = Math.max(0, Math.min(1, modelConfidence));
  if (!candidate.relationshipContext.length || candidate.graphDistance === null) {
    // Lexical similarity has already done its job by retrieving this bounded
    // candidate. Once the model has supplied verified source evidence, a weak
    // lexical score must not veto that decision a second time.
    return Number(boundedModel.toFixed(4));
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
  // Retrieval and graph signals can strengthen or rank a verified model
  // decision, but they cannot demote it. They are supporting evidence, not a
  // second negative classifier.
  const support = Math.min(
    0.1,
    Math.max(0, candidate.lexicalScore) * 0.04 +
      graphDistanceScore * 0.03 +
      relationshipScore * 0.03,
  );
  return Number((boundedModel + (1 - boundedModel) * support).toFixed(4));
}

function rankVerifiedDecisions(
  input: SemanticAnalysisInput,
  verified: ReturnType<typeof verifySemanticOutput>,
): ReturnType<typeof verifySemanticOutput> {
  const candidateById = new Map(input.candidates.map((candidate) => [candidate.id, candidate]));
  const accepted: VerifiedSemanticDecision[] = [];
  const rejected = [...verified.rejected];
  const traceByCandidateId = verified.decisionTrace
    ? new Map(verified.decisionTrace.map((trace) => [trace.candidateId, trace]))
    : null;
  for (const decision of verified.accepted) {
    const candidate = candidateById.get(decision.candidateId);
    if (!candidate) continue;
    const confidence = combinedSemanticConfidence(decision.confidence, candidate);
    if (confidence < MIN_SEMANTIC_DISPLAY_CONFIDENCE) {
      const trace = traceByCandidateId?.get(decision.candidateId);
      if (trace) {
        traceByCandidateId!.set(decision.candidateId, {
          ...trace,
          combinedConfidence: confidence,
          disposition: "COMBINED_CONFIDENCE_BELOW_THRESHOLD",
        });
      }
      rejected.push({
        candidateId: decision.candidateId,
        reason: "LOW_COMBINED_CONFIDENCE",
      });
      continue;
    }
    const trace = traceByCandidateId?.get(decision.candidateId);
    if (trace) {
      traceByCandidateId!.set(decision.candidateId, {
        ...trace,
        combinedConfidence: confidence,
        disposition: "ACCEPTED",
      });
    }
    accepted.push({ ...decision, confidence });
  }
  accepted.sort((left, right) =>
    right.confidence - left.confidence || left.candidateId.localeCompare(right.candidateId),
  );
  return {
    ...verified,
    accepted,
    rejected,
    decisionTrace: traceByCandidateId
      ? input.candidates.map((candidate) => traceByCandidateId.get(candidate.id)!)
      : undefined,
  };
}

function fallbackDecisionTrace(
  input: SemanticAnalysisInput,
  options: SemanticExecutionOptions,
): SemanticCandidateDecisionTrace[] | undefined {
  if (!options.traceDecisions) return undefined;
  return input.candidates.map((candidate) => ({
    candidateId: candidate.id,
    modelImpact: null,
    modelConfidence: null,
    evidenceStatus: "NOT_REQUESTED",
    combinedConfidence: null,
    disposition: "ANALYZER_FALLBACK",
  }));
}

export async function executeSemanticAnalysis(
  input: SemanticAnalysisInput,
  analyzer?: SemanticAnalyzer,
  options: SemanticExecutionOptions = {},
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
      decisionTrace: fallbackDecisionTrace(input, options),
      failureReason: "SEMANTIC_ANALYZER_NOT_CONFIGURED",
      usage: {
        promptTokens: null,
        completionTokens: null,
        estimatedCostMicros: null,
      },
    };
  }
  const executionAnalyzerVersion = analyzer.version
    ? `${SEMANTIC_ANALYZER_VERSION}/${analyzer.version}`
    : SEMANTIC_ANALYZER_VERSION;
  try {
    const result = await analyzer.analyze(input);
    const verified = rankVerifiedDecisions(
      input,
      verifySemanticOutput(input, result.output, options),
    );
    return {
      status: "succeeded",
      analyzerVersion: executionAnalyzerVersion,
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
      analyzerVersion: executionAnalyzerVersion,
      analyzerName: analyzer.name,
      model: analyzer.model,
      latencyMs: Date.now() - startedAt,
      inputCandidateCount: input.candidates.length,
      outputDecisionCount: 0,
      accepted: [],
      rejected: [],
      decisionTrace: fallbackDecisionTrace(input, options),
      failureReason: error instanceof Error ? error.message : "SEMANTIC_ANALYZER_FAILED",
      usage: {
        promptTokens: null,
        completionTokens: null,
        estimatedCostMicros: null,
      },
    };
  }
}
