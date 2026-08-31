import {
  buildSemanticAnalysisInput,
  executeSemanticAnalysis,
  generateSemanticCandidates,
  type SemanticCandidateDecisionTrace,
  type SemanticCandidateDisposition,
  type SemanticAnalyzer,
} from "../lib/analysis/semantic";
import type { EvaluationMetrics } from "../lib/analysis/evaluation";
import {
  evaluateFinalPredictions,
  loadLocalEvaluationPackage,
  type LoadedProductEvaluationCase,
} from "./specgraph-product-cases";

export type SemanticAnalyzerCaseResult = {
  id: string;
  expected: string[];
  predicted: string[];
  candidateCount: number;
  status: "succeeded" | "fallback";
  failureReason: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  latencyMs: number;
  candidateTraces: SemanticAnalyzerCandidateTrace[];
  falseNegatives: SemanticAnalyzerCandidateTrace[];
};

export type SemanticAnalyzerCandidateTrace = Omit<
  SemanticCandidateDecisionTrace,
  "disposition"
> & {
  path: string;
  kind: string;
  expected: boolean;
  predicted: boolean;
  retrievalRank: number | null;
  lexicalScore: number | null;
  graphDistance: number | null;
  relationshipSignalCount: number;
  disposition: SemanticCandidateDisposition | "NOT_RETRIEVED";
};

export type SemanticAnalyzerEvaluationReport = {
  analyzerName: string;
  model: string;
  caseCount: number;
  fallbackCaseCount: number;
  promptTokens: number | null;
  completionTokens: number | null;
  latencyMs: number;
  metrics: EvaluationMetrics;
  candidateDispositionCounts: Partial<
    Record<SemanticAnalyzerCandidateTrace["disposition"], number>
  >;
  falseNegativeDispositionCounts: Partial<
    Record<SemanticAnalyzerCandidateTrace["disposition"], number>
  >;
  cases: SemanticAnalyzerCaseResult[];
};

export type SemanticAnalyzerEvaluationOptions = {
  delayBetweenCasesMs?: number;
  stopOnFallback?: boolean;
  wait?: (durationMs: number) => Promise<void>;
};

async function waitFor(durationMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, durationMs));
}

function sumNullable(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length ? present.reduce((sum, value) => sum + value, 0) : null;
}

function countDispositions(
  traces: SemanticAnalyzerCandidateTrace[],
): Partial<Record<SemanticAnalyzerCandidateTrace["disposition"], number>> {
  return traces.reduce<
    Partial<Record<SemanticAnalyzerCandidateTrace["disposition"], number>>
  >((counts, trace) => {
    counts[trace.disposition] = (counts[trace.disposition] || 0) + 1;
    return counts;
  }, {});
}

export async function runSemanticAnalyzerEvaluation(
  analyzer: SemanticAnalyzer,
  cases: LoadedProductEvaluationCase[] = loadLocalEvaluationPackage(),
  options: SemanticAnalyzerEvaluationOptions = {},
): Promise<SemanticAnalyzerEvaluationReport> {
  const results: SemanticAnalyzerCaseResult[] = [];
  const predictions: Record<string, string[]> = {};
  const delayBetweenCasesMs = Math.max(0, options.delayBetweenCasesMs ?? 0);
  const wait = options.wait ?? waitFor;

  for (const [index, evaluationCase] of cases.entries()) {
    if (index > 0 && delayBetweenCasesMs > 0) {
      await wait(delayBetweenCasesMs);
    }
    const candidates = generateSemanticCandidates(
      evaluationCase.changed,
      evaluationCase.candidates,
    );
    const input = buildSemanticAnalysisInput(
      `evaluation:${evaluationCase.id}`,
      evaluationCase.changed,
      candidates,
    );
    const execution = await executeSemanticAnalysis(input, analyzer, {
      traceDecisions: true,
    });
    const predicted = execution.accepted.map((decision) => decision.candidateId);
    const expected = new Set(evaluationCase.expectedAffected);
    const traceByCandidateId = new Map(
      (execution.decisionTrace || []).map((trace) => [trace.candidateId, trace]),
    );
    const candidateTraces: SemanticAnalyzerCandidateTrace[] = candidates.map(
      (candidate, candidateIndex) => {
        const trace = traceByCandidateId.get(candidate.id) || {
          candidateId: candidate.id,
          modelImpact: null,
          modelConfidence: null,
          evidenceStatus: "NOT_REQUESTED" as const,
          combinedConfidence: null,
          disposition: "ANALYZER_FALLBACK" as const,
        };
        return {
          ...trace,
          path: candidate.artifact.path,
          kind: candidate.artifact.kind,
          expected: expected.has(candidate.id),
          predicted: predicted.includes(candidate.id),
          retrievalRank: candidateIndex + 1,
          lexicalScore: candidate.lexicalScore,
          graphDistance: candidate.graphDistance,
          relationshipSignalCount: candidate.relationshipContext.length,
        };
      },
    );
    for (const expectedCandidateId of expected) {
      if (candidates.some((candidate) => candidate.id === expectedCandidateId)) continue;
      const snapshot = evaluationCase.candidates.find(
        (candidate) => candidate.nodeId === expectedCandidateId,
      );
      candidateTraces.push({
        candidateId: expectedCandidateId,
        path: snapshot?.path || expectedCandidateId,
        kind: snapshot?.kind || "unknown",
        expected: true,
        predicted: false,
        retrievalRank: null,
        lexicalScore: null,
        graphDistance: null,
        relationshipSignalCount: 0,
        modelImpact: null,
        modelConfidence: null,
        evidenceStatus: "NOT_REQUESTED",
        combinedConfidence: null,
        disposition: "NOT_RETRIEVED",
      });
    }
    predictions[evaluationCase.id] = predicted;
    results.push({
      id: evaluationCase.id,
      expected: evaluationCase.expectedAffected,
      predicted,
      candidateCount: candidates.length,
      status: execution.status,
      failureReason: execution.failureReason,
      promptTokens: execution.usage.promptTokens,
      completionTokens: execution.usage.completionTokens,
      latencyMs: execution.latencyMs,
      candidateTraces,
      falseNegatives: candidateTraces.filter(
        (trace) => trace.expected && trace.disposition !== "ACCEPTED",
      ),
    });
    if (options.stopOnFallback && execution.status === "fallback") break;
  }

  const candidateTraces = results.flatMap((result) => result.candidateTraces);
  const falseNegatives = results.flatMap((result) => result.falseNegatives);
  const evaluatedCases = cases.slice(0, results.length);
  return {
    analyzerName: analyzer.name,
    model: analyzer.model,
    caseCount: results.length,
    fallbackCaseCount: results.filter((result) => result.status === "fallback").length,
    promptTokens: sumNullable(results.map((result) => result.promptTokens)),
    completionTokens: sumNullable(results.map((result) => result.completionTokens)),
    latencyMs: results.reduce((sum, result) => sum + result.latencyMs, 0),
    metrics: evaluateFinalPredictions(predictions, evaluatedCases),
    candidateDispositionCounts: countDispositions(candidateTraces),
    falseNegativeDispositionCounts: countDispositions(falseNegatives),
    cases: results,
  };
}
