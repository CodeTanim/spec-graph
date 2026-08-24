export type EvaluationCaseResult = {
  expected: string[];
  predicted: string[];
  candidateUniverse: string[];
};

export type EvaluationMetrics = {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  trueNegatives: number;
  precision: number;
  recall: number;
  f1: number;
  falsePositiveRate: number;
};

function ratio(numerator: number, denominator: number): number {
  if (!denominator) return numerator ? 0 : 1;
  return numerator / denominator;
}

export function calculateEvaluationMetrics(
  cases: EvaluationCaseResult[],
): EvaluationMetrics {
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  let trueNegatives = 0;

  for (const result of cases) {
    const expected = new Set(result.expected);
    const predicted = new Set(result.predicted);
    const universe = new Set([
      ...result.candidateUniverse,
      ...result.expected,
      ...result.predicted,
    ]);
    for (const candidate of universe) {
      const shouldFind = expected.has(candidate);
      const didFind = predicted.has(candidate);
      if (shouldFind && didFind) truePositives += 1;
      else if (!shouldFind && didFind) falsePositives += 1;
      else if (shouldFind) falseNegatives += 1;
      else trueNegatives += 1;
    }
  }

  const precision = ratio(truePositives, truePositives + falsePositives);
  const recall = ratio(truePositives, truePositives + falseNegatives);
  return {
    truePositives,
    falsePositives,
    falseNegatives,
    trueNegatives,
    precision,
    recall,
    f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
    falsePositiveRate: ratio(falsePositives, falsePositives + trueNegatives),
  };
}
