import { describe, expect, it, vi } from "vitest";
import { runSemanticAnalyzerEvaluation } from "../evaluation/semantic-analyzer-evaluation";
import {
  loadLocalEvaluationPackage,
  productEvaluationCases,
} from "../evaluation/specgraph-product-cases";
import type { SemanticAnalyzer } from "../lib/analysis/semantic";

describe("semantic analyzer evaluation harness", () => {
  it("scores verified final decisions over the same 25 reviewed cases", async () => {
    const expectedByCase = new Map(
      productEvaluationCases.map((value) => [value.id, new Set(value.expectedAffected)]),
    );
    const analyzer: SemanticAnalyzer = {
      name: "fixture-oracle",
      model: "local/oracle",
      async analyze(input) {
        const caseId = input.runId.replace(/^evaluation:/, "");
        const expected = expectedByCase.get(caseId) || new Set<string>();
        return {
          output: {
            schemaVersion: "1",
            decisions: input.candidates.map((candidate) => ({
              candidateId: candidate.id,
              impact: expected.has(candidate.id),
              confidence: expected.has(candidate.id) ? 0.99 : 0.02,
              summary: expected.has(candidate.id)
                ? "The candidate describes behavior affected by this change."
                : "The candidate does not describe behavior affected by this change.",
              changedExcerpt: expected.has(candidate.id)
                ? input.changed.text.slice(0, 40)
                : null,
              candidateExcerpt: expected.has(candidate.id)
                ? candidate.artifact.text.slice(0, 40)
                : null,
            })),
          },
          usage: {
            promptTokens: 100,
            completionTokens: 25,
            estimatedCostMicros: null,
          },
        };
      },
    };

    const report = await runSemanticAnalyzerEvaluation(
      analyzer,
      loadLocalEvaluationPackage(),
    );

    expect(report).toMatchObject({
      analyzerName: "fixture-oracle",
      model: "local/oracle",
      caseCount: 25,
      fallbackCaseCount: 0,
      promptTokens: 2_500,
      completionTokens: 625,
      metrics: {
        precision: 1,
        recall: 1,
        f1: 1,
        falsePositiveRate: 0,
      },
      falseNegativeDispositionCounts: {},
    });
  });

  it("can pace live cases without delaying the network-free suite", async () => {
    const wait = vi.fn(async () => undefined);
    const analyzer: SemanticAnalyzer = {
      name: "fixture-rejector",
      model: "local/rejector",
      async analyze(input) {
        return {
          output: {
            schemaVersion: "1",
            decisions: input.candidates.map((candidate) => ({
              candidateId: candidate.id,
              impact: false,
              confidence: 0.99,
              summary: "No review is needed.",
              changedExcerpt: null,
              candidateExcerpt: null,
            })),
          },
          usage: {
            promptTokens: 1,
            completionTokens: 1,
            estimatedCostMicros: null,
          },
        };
      },
    };

    await runSemanticAnalyzerEvaluation(
      analyzer,
      loadLocalEvaluationPackage().slice(0, 3),
      { delayBetweenCasesMs: 13_000, wait },
    );

    expect(wait).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenNthCalledWith(1, 13_000);
    expect(wait).toHaveBeenNthCalledWith(2, 13_000);
  });

  it("reports privacy-safe false-negative reasons with retrieval metadata", async () => {
    const [evaluationCase] = loadLocalEvaluationPackage();
    const analyzer: SemanticAnalyzer = {
      name: "fixture-rejector",
      model: "local/rejector",
      async analyze(input) {
        return {
          output: {
            schemaVersion: "1",
            decisions: input.candidates.map((candidate) => ({
              candidateId: candidate.id,
              impact: false,
              confidence: 0.97,
              summary: "No review is needed.",
              changedExcerpt: null,
              candidateExcerpt: null,
            })),
          },
          usage: {
            promptTokens: 1,
            completionTokens: 1,
            estimatedCostMicros: null,
          },
        };
      },
    };

    const report = await runSemanticAnalyzerEvaluation(analyzer, [evaluationCase]);
    const [falseNegative] = report.cases[0].falseNegatives;

    expect(falseNegative).toEqual(expect.objectContaining({
      candidateId: evaluationCase.expectedAffected[0],
      expected: true,
      predicted: false,
      retrievalRank: expect.any(Number),
      lexicalScore: expect.any(Number),
      relationshipSignalCount: expect.any(Number),
      disposition: "MODEL_NEGATIVE",
    }));
    expect(report.falseNegativeDispositionCounts).toEqual({ MODEL_NEGATIVE: 1 });
    const serializedTrace = JSON.stringify(report.cases[0].candidateTraces);
    expect(serializedTrace).not.toContain(evaluationCase.changed.text);
    expect(serializedTrace).not.toContain("No review is needed.");
    expect(serializedTrace).not.toContain("changedExcerpt");
    expect(serializedTrace).not.toContain("candidateExcerpt");
  });

  it("can stop a paid live evaluation after the first provider fallback", async () => {
    const analyzer: SemanticAnalyzer = {
      name: "fixture-outage",
      model: "local/outage",
      async analyze() {
        throw new Error("provider unavailable");
      },
    };

    const report = await runSemanticAnalyzerEvaluation(
      analyzer,
      loadLocalEvaluationPackage().slice(0, 3),
      { stopOnFallback: true },
    );

    expect(report.caseCount).toBe(1);
    expect(report.fallbackCaseCount).toBe(1);
    expect(report.cases[0]).toMatchObject({
      status: "fallback",
      failureReason: "provider unavailable",
    });
  });
});
