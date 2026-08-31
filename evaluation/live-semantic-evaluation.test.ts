import { describe, expect, it } from "vitest";
import {
  AI_GATEWAY_CALIBRATION_VERSION,
  createConfiguredSemanticAnalyzer,
} from "../lib/analysis/ai-gateway-analyzer";
import { runSemanticAnalyzerEvaluation } from "./semantic-analyzer-evaluation";
import {
  loadLocalEvaluationPackage,
  PRODUCT_EVALUATION_VERSION,
} from "./specgraph-product-cases";

function evaluationDelayMs(): number {
  const configured = process.env.SPECGRAPH_SEMANTIC_EVAL_DELAY_MS;
  if (!configured) return 0;
  const parsed = Number(configured);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("SPECGRAPH_SEMANTIC_EVAL_DELAY_MS must be a non-negative number");
  }
  return parsed;
}

function evaluationRunCount(): number {
  const configured = process.env.SPECGRAPH_SEMANTIC_EVAL_RUNS;
  if (!configured) return 1;
  const parsed = Number(configured);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5) {
    throw new Error("SPECGRAPH_SEMANTIC_EVAL_RUNS must be an integer from 1 to 5");
  }
  return parsed;
}

function selectedEvaluationCases() {
  const allCases = loadLocalEvaluationPackage();
  const configured = process.env.SPECGRAPH_SEMANTIC_EVAL_CASES?.trim();
  if (!configured) return { cases: allCases, targeted: false };
  const selectedIds = new Set(
    configured.split(",").map((value) => value.trim()).filter(Boolean),
  );
  const cases = allCases.filter((value) => selectedIds.has(value.id));
  if (!cases.length || cases.length !== selectedIds.size) {
    throw new Error("SPECGRAPH_SEMANTIC_EVAL_CASES contains an unknown case ID");
  }
  return { cases, targeted: true };
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

const CRITICAL_EXPECTATIONS = [
  ["code-workspace-authorization", "confluence/security-and-access.md"],
  ["code-evidence-verification", "confluence/how-specgraph-works.md"],
  ["doc-evidence-contract", "repository/evidence-verification.ts"],
] as const;

// A full Gateway pass is intentionally sequential and can take several
// minutes. Scale the Vitest deadline with the requested stability-run count so
// the release gate does not fail merely because three valid passes exceed the
// one-pass timeout.
const LIVE_EVALUATION_TIMEOUT_MS = evaluationRunCount() * 360_000 + 60_000;

describe("opt-in live semantic evaluation", () => {
  it("measures the configured model over all reviewed cases", async () => {
    const analyzer = createConfiguredSemanticAnalyzer();
    if (!analyzer) {
      throw new Error(
        "Set SPECGRAPH_SEMANTIC_MODEL and authenticate with AI_GATEWAY_API_KEY or Vercel OIDC before running the live evaluation",
      );
    }
    const { cases, targeted } = selectedEvaluationCases();
    const reports = [];
    for (let run = 0; run < evaluationRunCount(); run += 1) {
      const current = await runSemanticAnalyzerEvaluation(analyzer, cases, {
        delayBetweenCasesMs: evaluationDelayMs(),
        stopOnFallback: true,
      });
      reports.push(current);
      console.log(JSON.stringify({
        event: "semantic_calibration_run",
        run: run + 1,
        caseCount: current.caseCount,
        fallbackCaseCount: current.fallbackCaseCount,
        promptTokens: current.promptTokens,
        completionTokens: current.completionTokens,
        latencyMs: current.latencyMs,
        metrics: current.metrics,
      }));
    }
    const report = reports[reports.length - 1]!;
    console.log(JSON.stringify({
      analyzerName: report.analyzerName,
      model: report.model,
      calibrationVersion: AI_GATEWAY_CALIBRATION_VERSION,
      evaluationVersion: PRODUCT_EVALUATION_VERSION,
      caseCount: report.caseCount,
      calibrationRuns: reports.length,
      stability: {
        minimumPrecision: Math.min(...reports.map((value) => value.metrics.precision)),
        minimumRecall: Math.min(...reports.map((value) => value.metrics.recall)),
        meanPrecision: mean(reports.map((value) => value.metrics.precision)),
        meanRecall: mean(reports.map((value) => value.metrics.recall)),
      },
      runs: reports.map((value, index) => ({
        run: index + 1,
        fallbackCaseCount: value.fallbackCaseCount,
        fallbackReasons: Array.from(new Set(
          value.cases
            .map((result) => result.failureReason)
            .filter((reason): reason is string => Boolean(reason)),
        )),
        promptTokens: value.promptTokens,
        completionTokens: value.completionTokens,
        latencyMs: value.latencyMs,
        metrics: value.metrics,
        candidateDispositionCounts: value.candidateDispositionCounts,
        falseNegativeDispositionCounts: value.falseNegativeDispositionCounts,
        falsePositives: value.cases.flatMap((result) =>
          result.candidateTraces
            .filter((trace) => !trace.expected && trace.predicted)
            .map((trace) => ({
              caseId: result.id,
              candidateId: trace.candidateId,
              retrievalRank: trace.retrievalRank,
              lexicalScore: trace.lexicalScore,
              modelConfidence: trace.modelConfidence,
              modelDecisionBasis: trace.modelDecisionBasis,
              combinedConfidence: trace.combinedConfidence,
            }))),
        falseNegatives: value.cases.flatMap((result) =>
          result.falseNegatives.map((trace) => ({
            caseId: result.id,
            candidateId: trace.candidateId,
            disposition: trace.disposition,
            retrievalRank: trace.retrievalRank,
            lexicalScore: trace.lexicalScore,
            modelImpact: trace.modelImpact,
            modelConfidence: trace.modelConfidence,
            modelDecisionBasis: trace.modelDecisionBasis,
            evidenceStatus: trace.evidenceStatus,
            combinedConfidence: trace.combinedConfidence,
          }))),
      })),
    }, null, 2));
    expect(reports.every((value) => value.caseCount === cases.length)).toBe(true);
    expect(reports.every((value) => value.fallbackCaseCount === 0)).toBe(true);
    if (targeted) return;
    expect(Math.min(...reports.map((value) => value.metrics.precision))).toBeGreaterThanOrEqual(0.95);
    expect(Math.min(...reports.map((value) => value.metrics.recall))).toBeGreaterThanOrEqual(0.85);
    expect(reports.every((value) =>
      CRITICAL_EXPECTATIONS.every(([caseId, candidateId]) =>
        value.cases.find((result) => result.id === caseId)?.predicted.includes(candidateId),
      ),
    )).toBe(true);
  }, LIVE_EVALUATION_TIMEOUT_MS);
});
