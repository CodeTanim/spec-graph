import type { AnalysisArtifactKind, CandidateEdge } from "./candidates";

export const SEMANTIC_ANALYZER_VERSION = "semantic-contract-v1";
export const SEMANTIC_RETRIEVAL_VERSION = "role-aware-full-file-v2";
// Retrieval is deliberately narrow: the reviewed evaluation package keeps
// every expected target in the top three, so sending lower-ranked lexical
// neighbors only adds cost and false-positive opportunities.
export const MAX_SEMANTIC_CANDIDATES = 3;
export const MAX_SEMANTIC_TEXT_CHARS = 6_000;
export const MIN_SEMANTIC_DISPLAY_CONFIDENCE = 0.78;
const MAX_SEMANTIC_RETRIEVAL_CHARS = 160_000;
const SEMANTIC_RETRIEVAL_WINDOW_CHARS = 1_200;
const SEMANTIC_RETRIEVAL_WINDOW_OVERLAP = 200;
const MAX_SEMANTIC_RETRIEVAL_SEGMENTS = 2_048;

export type SemanticArtifactSnapshot = {
  nodeId: string;
  artifactId: string;
  kind: AnalysisArtifactKind;
  path: string;
  revision: string;
  sourceUrl: string | null;
  text: string;
  /** First source line represented by `text`; omitted for a full snapshot. */
  textStartLine?: number;
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

const CADENCE_TOKENS = new Set([
  "cadence",
  "cron",
  "crons",
  "schedule",
  "scheduled",
  "scheduling",
]);

function canonicalToken(token: string): string {
  if (CADENCE_TOKENS.has(token)) {
    return "cadence";
  }
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

type SemanticSegment = {
  start: number;
  end: number;
  tokens: Set<string>;
};

function semanticSegments(text: string): SemanticSegment[] {
  const bounded = text.slice(0, MAX_SEMANTIC_RETRIEVAL_CHARS);
  if (!bounded) return [];
  const segments: SemanticSegment[] = [];
  const seen = new Set<string>();
  const add = (start: number, end: number) => {
    if (segments.length >= MAX_SEMANTIC_RETRIEVAL_SEGMENTS) return;
    const key = `${start}:${end}`;
    if (seen.has(key)) return;
    const tokenSet = tokens(bounded.slice(start, end));
    if (tokenSet.size < 3) return;
    seen.add(key);
    segments.push({ start, end, tokens: tokenSet });
  };
  const step = SEMANTIC_RETRIEVAL_WINDOW_CHARS -
    SEMANTIC_RETRIEVAL_WINDOW_OVERLAP;
  for (let start = 0; start < bounded.length; start += step) {
    const end = Math.min(start + SEMANTIC_RETRIEVAL_WINDOW_CHARS, bounded.length);
    add(start, end);
    if (end === bounded.length) break;
  }
  // Windows guarantee whole-file coverage. Precise paragraphs and lines then
  // recover the high-signal sections needed for accurate lexical ranking.
  for (const match of bounded.matchAll(/\S[\s\S]*?(?=\n\s*\n|$)/gu)) {
    const start = match.index ?? 0;
    const value = match[0];
    if (value.trim().length >= 12) add(start, start + value.length);
  }
  for (const match of bounded.matchAll(/[^\n]+/gu)) {
    const start = match.index ?? 0;
    const value = match[0];
    if (value.trim().length >= 20) add(start, start + value.length);
  }
  return segments;
}

function cronCadenceFacts(schedule: string): string[] {
  const fields = schedule.trim().split(/\s+/u);
  if (fields.length !== 5) return ["scheduled cadence cron"];
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  const everyDay = dayOfMonth === "*" && month === "*" && dayOfWeek === "*";
  if (!everyDay) return ["scheduled cadence cron"];
  if (/^\d+$/u.test(minute) && /^\d+$/u.test(hour)) {
    return ["automatic scheduled cadence once per day daily every 24 hours cron"];
  }
  const hourlyInterval = /^\*\/(\d+)$/u.exec(hour);
  if (/^\d+$/u.test(minute) && hourlyInterval) {
    return [
      "automatic scheduled cadence interval cron",
      `every ${hourlyInterval[1]} hours`,
    ];
  }
  return ["automatic scheduled cadence cron"];
}

function configRetrievalFacts(snapshot: SemanticArtifactSnapshot): string {
  if (snapshot.kind !== "config" || snapshot.path.toLowerCase() !== "vercel.json") {
    return "";
  }
  try {
    const parsed = JSON.parse(snapshot.text) as { crons?: unknown };
    if (!Array.isArray(parsed.crons)) return "";
    return parsed.crons
      .flatMap((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
        const schedule = (entry as { schedule?: unknown }).schedule;
        return typeof schedule === "string" ? cronCadenceFacts(schedule) : [];
      })
      .join(" ");
  } catch {
    // Retrieval hints are optional. Invalid configuration remains available as
    // raw source evidence but receives no synthetic cadence hint.
    return "";
  }
}

export function sectionAwareLexicalSimilarity(
  leftText: string,
  rightText: string,
): number {
  return sectionAwareTokenSimilarity(
    semanticSegments(leftText).map((segment) => segment.tokens),
    semanticSegments(rightText).map((segment) => segment.tokens),
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

function boundedSnapshot(
  snapshot: SemanticArtifactSnapshot,
  focus?: Pick<SemanticSegment, "start" | "end">,
): SemanticArtifactSnapshot {
  if (snapshot.text.length <= MAX_SEMANTIC_TEXT_CHARS) return snapshot;
  const focusCenter = focus
    ? Math.floor((focus.start + focus.end) / 2)
    : Math.floor(MAX_SEMANTIC_TEXT_CHARS / 2);
  let start = Math.max(0, focusCenter - Math.floor(MAX_SEMANTIC_TEXT_CHARS / 2));
  start = Math.min(start, snapshot.text.length - MAX_SEMANTIC_TEXT_CHARS);
  if (start > 0) {
    const nextNewline = snapshot.text.indexOf("\n", start);
    if (nextNewline >= 0 && (!focus || nextNewline < focus.start)) {
      // Move forward to a source-line boundary. Moving backward here can push
      // the focused evidence just beyond the 6,000-character prompt window.
      start = nextNewline + 1;
    }
  }
  const sourceStartLine = (snapshot.textStartLine ?? 1) +
    snapshot.text.slice(0, start).split("\n").length - 1;
  return {
    ...snapshot,
    text: snapshot.text.slice(start, start + MAX_SEMANTIC_TEXT_CHARS),
    textStartLine: sourceStartLine,
  };
}

function semanticSearchSegments(snapshot: SemanticArtifactSnapshot): SemanticSegment[] {
  const facts = configRetrievalFacts(snapshot);
  return semanticSegments(`${facts ? `${facts}\n` : ""}${snapshot.text}`);
}

function strongestSegmentMatch(
  changedSegments: SemanticSegment[],
  candidateSegments: SemanticSegment[],
): { score: number; candidateSegment: SemanticSegment | undefined } {
  let score = 0;
  let candidateSegment: SemanticSegment | undefined;
  for (const changed of changedSegments) {
    for (const candidate of candidateSegments) {
      const similarity = tokenSetSimilarity(changed.tokens, candidate.tokens);
      if (similarity > score) {
        score = similarity;
        candidateSegment = candidate;
      }
    }
  }
  return { score, candidateSegment };
}

function compareSemanticCandidates(
  left: SemanticCandidate,
  right: SemanticCandidate,
): number {
  return right.relationshipContext.length - left.relationshipContext.length ||
    right.lexicalScore - left.lexicalScore ||
    left.id.localeCompare(right.id);
}

function isDocumentationKind(kind: AnalysisArtifactKind): boolean {
  return kind === "markdown" || kind === "openapi" || kind === "confluence";
}

function selectSemanticSlate(
  changed: SemanticArtifactSnapshot,
  ranked: SemanticCandidate[],
): SemanticCandidate[] {
  if (!isDocumentationKind(changed.kind)) {
    return ranked.slice(0, MAX_SEMANTIC_CANDIDATES);
  }

  // A documentation change needs a balanced review slate: executable
  // configuration and production code must not be crowded out by several
  // similarly worded documents. Empty buckets are backfilled by rank.
  const selected: SemanticCandidate[] = [];
  const add = (candidate: SemanticCandidate | undefined) => {
    if (candidate && !selected.some((item) => item.id === candidate.id)) {
      selected.push(candidate);
    }
  };
  add(ranked.find((candidate) => candidate.artifact.kind === "config"));
  add(ranked.find((candidate) => candidate.artifact.kind === "code"));
  for (const candidate of ranked) {
    add(candidate);
    if (selected.length === MAX_SEMANTIC_CANDIDATES) break;
  }
  return selected.slice(0, MAX_SEMANTIC_CANDIDATES);
}

export function generateSemanticCandidates(
  changed: SemanticArtifactSnapshot,
  candidates: SemanticArtifactSnapshot[],
  contexts: Map<string, { graphDistance: number | null; edges: CandidateEdge[] }> = new Map(),
): SemanticCandidate[] {
  const changedSegments = semanticSearchSegments(changed);
  const ranked = candidates
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
      const match = strongestSegmentMatch(
        changedSegments,
        semanticSearchSegments(candidate),
      );
      const focus = match.candidateSegment
        ? {
            // Config facts are retrieval-only and precede the raw source. The
            // allowlisted config is currently shorter than the prompt bound;
            // regular artifacts map directly to source-text coordinates.
            start: match.candidateSegment.start,
            end: match.candidateSegment.end,
          }
        : undefined;
      return {
        id: candidate.nodeId,
        artifact: boundedSnapshot(candidate, focus),
        lexicalScore: match.score,
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
    .sort(compareSemanticCandidates);
  return selectSemanticSlate(changed, ranked);
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
      changedStartLine:
        (input.changed.textStartLine ?? 1) + changedEvidence.startLine - 1,
      candidateStartLine:
        (candidate.artifact.textStartLine ?? 1) + candidateEvidence.startLine - 1,
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
  if (!input.candidates.length) {
    return {
      status: "succeeded",
      analyzerVersion: analyzer?.version
        ? `${SEMANTIC_ANALYZER_VERSION}/${analyzer.version}`
        : SEMANTIC_ANALYZER_VERSION,
      analyzerName: analyzer?.name || null,
      model: analyzer?.model || null,
      latencyMs: 0,
      inputCandidateCount: 0,
      outputDecisionCount: 0,
      accepted: [],
      rejected: [],
      decisionTrace: [],
      failureReason: null,
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        estimatedCostMicros: 0,
      },
    };
  }
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
