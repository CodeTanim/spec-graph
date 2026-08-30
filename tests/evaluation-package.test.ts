import { describe, expect, it } from "vitest";
import {
  evaluateFinalPredictions,
  loadLocalEvaluationPackage,
  productEvaluationCases,
  runSemanticRetrievalBaseline,
  type EvaluationTag,
} from "../evaluation/specgraph-product-cases";

describe("25-case local product evaluation package", () => {
  it("contains 25 labeled, uniquely identified cases with every required scenario", () => {
    expect(productEvaluationCases).toHaveLength(25);
    expect(new Set(productEvaluationCases.map((value) => value.id)).size).toBe(25);

    const requiredTags: EvaluationTag[] = [
      "code-first",
      "documentation-first",
      "openapi",
      "test",
      "unrelated",
      "ambiguous",
    ];
    const observedTags = new Set(productEvaluationCases.flatMap((value) => value.tags));
    for (const tag of requiredTags) expect(observedTags.has(tag)).toBe(true);
    expect(
      productEvaluationCases.some(
        (value) => value.direction === "documentation-to-repository",
      ),
    ).toBe(true);
  });

  it("loads every fixture and keeps all expected targets in the candidate universe", () => {
    const cases = loadLocalEvaluationPackage();
    for (const evaluationCase of cases) {
      expect(evaluationCase.changed.text.length, evaluationCase.id).toBeGreaterThan(0);
      const candidateIds = new Set(
        evaluationCase.candidates.map((candidate) => candidate.nodeId),
      );
      for (const expected of evaluationCase.expectedAffected) {
        expect(candidateIds.has(expected), `${evaluationCase.id}: ${expected}`).toBe(true);
      }
    }
  });

  it("measures candidate retrieval without presenting it as final AI precision", () => {
    const report = runSemanticRetrievalBaseline();
    console.table({
      retrievalVersion: report.retrievalVersion,
      cases: report.caseCount,
      expectedTargets: report.expectedTargetCount,
      retrievalRecall: report.retrievalRecall.toFixed(3),
      topThreeRecall: report.topThreeRecall.toFixed(3),
      caseCoverage: report.caseCoverage.toFixed(3),
      averageCandidates: report.averageCandidateCount.toFixed(2),
      unrelatedCasesWithCandidates: report.unrelatedCasesWithCandidates,
    });
    const misses = report.cases
      .map((result) => ({
        id: result.id,
        missed: result.expected.filter((value) => !result.retrieved.includes(value)),
        retrieved: result.retrieved.slice(0, 5),
      }))
      .filter((result) => result.missed.length > 0);
    if (misses.length) console.table(misses);
    const unrelatedCandidates = report.cases.filter((result) =>
      result.expected.length === 0 && result.retrieved.length > 0
    );
    if (unrelatedCandidates.length) console.table(unrelatedCandidates);

    expect(report.caseCount).toBe(25);
    expect(report.retrievedExpectedTargetCount).toBeGreaterThanOrEqual(28);
    expect(report.topThreeExpectedTargetCount).toBeGreaterThanOrEqual(27);
    expect(report.unrelatedCasesWithCandidates).toBeLessThanOrEqual(1);
    expect(report.averageCandidateCount).toBeLessThanOrEqual(5);
  });

  it("scores future final analyzer decisions against the same labels", () => {
    const perfectPredictions = Object.fromEntries(
      productEvaluationCases.map((value) => [value.id, value.expectedAffected]),
    );
    expect(evaluateFinalPredictions(perfectPredictions)).toMatchObject({
      precision: 1,
      recall: 1,
      f1: 1,
      falsePositiveRate: 0,
    });
  });
});
