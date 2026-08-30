import { describe, expect, it } from "vitest";
import { createConfiguredSemanticAnalyzer } from "../lib/analysis/ai-gateway-analyzer";
import { runSemanticAnalyzerEvaluation } from "./semantic-analyzer-evaluation";

function evaluationDelayMs(): number {
  const configured = process.env.SPECGRAPH_SEMANTIC_EVAL_DELAY_MS;
  if (!configured) return 0;
  const parsed = Number(configured);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("SPECGRAPH_SEMANTIC_EVAL_DELAY_MS must be a non-negative number");
  }
  return parsed;
}

describe("opt-in live semantic evaluation", () => {
  it("measures the configured model over all reviewed cases", async () => {
    const analyzer = createConfiguredSemanticAnalyzer();
    if (!analyzer) {
      throw new Error(
        "Set SPECGRAPH_SEMANTIC_MODEL and AI_GATEWAY_API_KEY before running the live evaluation",
      );
    }
    const report = await runSemanticAnalyzerEvaluation(analyzer, undefined, {
      delayBetweenCasesMs: evaluationDelayMs(),
    });
    console.log(JSON.stringify({
      analyzerName: report.analyzerName,
      model: report.model,
      caseCount: report.caseCount,
      fallbackCaseCount: report.fallbackCaseCount,
      promptTokens: report.promptTokens,
      completionTokens: report.completionTokens,
      latencyMs: report.latencyMs,
      metrics: report.metrics,
      candidateDispositionCounts: report.candidateDispositionCounts,
      falseNegativeDispositionCounts: report.falseNegativeDispositionCounts,
      falseNegatives: report.cases.flatMap((result) =>
        result.falseNegatives.map((trace) => ({
          caseId: result.id,
          candidateId: trace.candidateId,
          disposition: trace.disposition,
          retrievalRank: trace.retrievalRank,
          lexicalScore: trace.lexicalScore,
          modelImpact: trace.modelImpact,
          modelConfidence: trace.modelConfidence,
          evidenceStatus: trace.evidenceStatus,
          combinedConfidence: trace.combinedConfidence,
        }))),
    }, null, 2));
    expect(report.caseCount).toBe(25);
    expect(report.fallbackCaseCount).toBe(0);
  }, 600_000);
});
