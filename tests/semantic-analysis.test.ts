import { describe, expect, it } from "vitest";
import {
  buildSemanticAnalysisInput,
  combinedSemanticConfidence,
  executeSemanticAnalysis,
  generateSemanticCandidates,
  sectionAwareLexicalSimilarity,
  verifySemanticOutput,
  type SemanticArtifactSnapshot,
} from "../lib/analysis/semantic";

const changed: SemanticArtifactSnapshot = {
  nodeId: "changed",
  artifactId: "a-changed",
  kind: "confluence",
  path: "PAY/Retry policy",
  revision: "4",
  sourceUrl: "https://example.atlassian.net/wiki/page/1",
  text: "Payment authorization retries three times before entering the failure queue.",
};

const related: SemanticArtifactSnapshot = {
  nodeId: "related",
  artifactId: "a-related",
  kind: "markdown",
  path: "docs/payment-retries.md",
  revision: "abc123",
  sourceUrl: "https://github.com/acme/payments/blob/abc123/docs/payment-retries.md",
  text: "Failed payment authorization requests retry three times before entering the failure queue.",
};

describe("bounded semantic candidate retrieval", () => {
  it("ranks lexical overlap and excludes unrelated candidates", () => {
    const candidates = generateSemanticCandidates(changed, [
      related,
      {
        ...related,
        nodeId: "unrelated",
        artifactId: "a-unrelated",
        path: "docs/colors.md",
        text: "The interface uses black text on a white background.",
      },
    ]);
    expect(candidates.map((candidate) => candidate.id)).toEqual(["related"]);
    expect(candidates[0].lexicalScore).toBeGreaterThan(0.5);
  });

  it("matches code-style identifiers to a relevant section in a longer product page", () => {
    const score = sectionAwareLexicalSimilarity(
      "export function shouldScheduleDailyAnalysis() { return 'daily'; }",
      [
        "# How the product works",
        "The interface uses a simple source list and review feed.",
        "## Keeping sources current",
        "Automatic analysis runs on a daily cadence and checks newly captured changes.",
        "## Reviewing suggestions",
        "A reviewer can dismiss or resolve each suggestion.",
      ].join("\n\n"),
    );
    expect(score).toBeGreaterThanOrEqual(0.12);
  });

  it("normalizes camel case, punctuation, plurals, and common inflections", () => {
    expect(
      sectionAwareLexicalSimilarity(
        "addEqualSourceMember(sourceGroup)",
        "Connected source-groups contain equal members.",
      ),
    ).toBeGreaterThan(0.5);
    expect(
      sectionAwareLexicalSimilarity(
        "preserveReviewDecision('dismissed')",
        "Review decisions persist when a suggestion is dismissed.",
      ),
    ).toBeGreaterThan(0.5);
    expect(
      sectionAwareLexicalSimilarity(
        "maximumAutomaticAttempts",
        "Work stops after the configured attempt limit.",
      ),
    ).toBeGreaterThanOrEqual(0.12);
  });

  it("combines model, lexical, graph-distance, and edge-origin signals", () => {
    const [candidate] = generateSemanticCandidates(
      changed,
      [related],
      new Map([["related", {
        graphDistance: 1,
        edges: [{
          id: "edge-1",
          fromNodeId: "changed",
          toNodeId: "related",
          type: "documents",
          origin: "deterministic",
          provenance: "EXACT_PATH",
          confidence: 1,
          evidence: "Exact path reference",
          evidenceStartLine: 1,
        }],
      }]]),
    );
    expect(combinedSemanticConfidence(0.82, candidate)).toBeGreaterThan(0.82);
  });

  it("does not use retrieval similarity as negative evidence after verification", () => {
    const [candidate] = generateSemanticCandidates(changed, [related]);
    const lowLexicalCandidate = { ...candidate, lexicalScore: 0.2 };

    expect(combinedSemanticConfidence(0.8, lowLexicalCandidate)).toBe(0.8);
  });

  it("keeps tests as supporting context for documentation-first review", () => {
    const productionImplementation = {
      ...related,
      nodeId: "implementation",
      artifactId: "a-implementation",
      kind: "code" as const,
      path: "src/payment-retries.ts",
    };
    const supportingTest = {
      ...related,
      nodeId: "supporting-test",
      artifactId: "a-supporting-test",
      kind: "test" as const,
      path: "tests/payment-retries.test.ts",
    };

    expect(
      generateSemanticCandidates(changed, [productionImplementation, supportingTest])
        .map((candidate) => candidate.id),
    ).toEqual(["implementation"]);
  });
});

describe("semantic evidence verification", () => {
  it("accepts only exact excerpts from the supplied revisions", () => {
    const input = buildSemanticAnalysisInput(
      "run-1",
      changed,
      generateSemanticCandidates(changed, [related]),
    );
    const verified = verifySemanticOutput(input, {
      schemaVersion: "1",
      decisions: [{
        candidateId: "related",
        impact: true,
        confidence: 0.91,
        summary: "Both sources specify the same retry behavior.",
        changedExcerpt: "retries three times",
        candidateExcerpt: "retry three times",
      }],
    });
    expect(verified.accepted).toEqual([
      expect.objectContaining({ candidateId: "related", candidateStartLine: 1 }),
    ]);
    expect(verified.rejected).toEqual([]);
  });

  it("recovers byte-exact source evidence when a model normalizes whitespace", () => {
    const formattedChanged = {
      ...changed,
      text: [
        "Retry behavior",
        "Payment authorization retries\n  three times before entering the failure queue.",
      ].join("\n"),
    };
    const formattedRelated = {
      ...related,
      text: [
        "# Payment failures",
        "Policy",
        "Failed payment authorization requests\n\tretry three times before entering the failure queue.",
      ].join("\n"),
    };
    const input = buildSemanticAnalysisInput(
      "run-whitespace",
      formattedChanged,
      generateSemanticCandidates(formattedChanged, [formattedRelated]),
    );

    const verified = verifySemanticOutput(input, {
      schemaVersion: "1",
      decisions: [{
        candidateId: "related",
        impact: true,
        confidence: 0.91,
        summary: "Both sources specify the same retry behavior.",
        changedExcerpt: "Payment authorization retries three times",
        candidateExcerpt: "authorization requests retry three times",
      }],
    });

    expect(verified.rejected).toEqual([]);
    expect(verified.accepted).toEqual([expect.objectContaining({
      candidateId: "related",
      changedExcerpt: "Payment authorization retries\n  three times",
      candidateExcerpt: "authorization requests\n\tretry three times",
      changedStartLine: 2,
      candidateStartLine: 3,
    })]);
  });

  it("rejects hallucinated evidence and unknown output fields", () => {
    const input = buildSemanticAnalysisInput(
      "run-1",
      changed,
      generateSemanticCandidates(changed, [related]),
    );
    expect(verifySemanticOutput(input, {
      schemaVersion: "1",
      decisions: [{
        candidateId: "related",
        impact: true,
        confidence: 0.95,
        summary: "Unsupported claim.",
        changedExcerpt: "retries forever",
        candidateExcerpt: "retry three times",
      }],
    }).rejected).toContainEqual({
      candidateId: "related",
      reason: "UNVERIFIED_EVIDENCE",
    });
    expect(verifySemanticOutput(input, {
      schemaVersion: "1",
      decisions: [],
      explanation: "unexpected",
    }).rejected).toContainEqual({
      candidateId: null,
      reason: "INVALID_OUTPUT_SCHEMA",
    });
  });

  it("suppresses low-confidence output", () => {
    const input = buildSemanticAnalysisInput(
      "run-1",
      changed,
      generateSemanticCandidates(changed, [related]),
    );
    const verified = verifySemanticOutput(input, {
      schemaVersion: "1",
      decisions: [{
        candidateId: "related",
        impact: true,
        confidence: 0.5,
        summary: "Maybe related.",
        changedExcerpt: "retries three times",
        candidateExcerpt: "retry three times",
      }],
    });
    expect(verified.accepted).toEqual([]);
    expect(verified.rejected).toEqual([]);
  });

  it.each([
    {
      name: "model negative",
      decision: {
        candidateId: "related",
        impact: false,
        confidence: 0.96,
        summary: "The sources describe different behavior.",
        changedExcerpt: null,
        candidateExcerpt: null,
      },
      disposition: "MODEL_NEGATIVE",
      evidenceStatus: "NOT_REQUESTED",
    },
    {
      name: "model confidence below threshold",
      decision: {
        candidateId: "related",
        impact: true,
        confidence: 0.5,
        summary: "The connection is too weak for review.",
        changedExcerpt: "retries three times",
        candidateExcerpt: "retry three times",
      },
      disposition: "MODEL_CONFIDENCE_BELOW_THRESHOLD",
      evidenceStatus: "NOT_REQUESTED",
    },
    {
      name: "missing evidence",
      decision: {
        candidateId: "related",
        impact: true,
        confidence: 0.95,
        summary: "The sources describe the same retry behavior.",
        changedExcerpt: null,
        candidateExcerpt: null,
      },
      disposition: "EVIDENCE_REQUIRED",
      evidenceStatus: "MISSING",
    },
    {
      name: "unverified evidence",
      decision: {
        candidateId: "related",
        impact: true,
        confidence: 0.95,
        summary: "The sources describe the same retry behavior.",
        changedExcerpt: "retries forever",
        candidateExcerpt: "retry three times",
      },
      disposition: "EVIDENCE_UNVERIFIED",
      evidenceStatus: "UNVERIFIED",
    },
  ])("traces $name without storing source excerpts", ({
    decision,
    disposition,
    evidenceStatus,
  }) => {
    const input = buildSemanticAnalysisInput(
      "run-trace",
      changed,
      generateSemanticCandidates(changed, [related]),
    );
    const verified = verifySemanticOutput(input, {
      schemaVersion: "1",
      decisions: [decision],
    }, { traceDecisions: true });

    expect(verified.decisionTrace).toEqual([
      expect.objectContaining({
        candidateId: "related",
        disposition,
        evidenceStatus,
      }),
    ]);
    expect(JSON.stringify(verified.decisionTrace)).not.toContain("retries three times");
    expect(JSON.stringify(verified.decisionTrace)).not.toContain(decision.summary);
  });

  it("distinguishes missing, invalid, and invalid-output decisions", () => {
    const input = buildSemanticAnalysisInput(
      "run-trace",
      changed,
      generateSemanticCandidates(changed, [related]),
    );

    expect(verifySemanticOutput(input, {
      schemaVersion: "1",
      decisions: [],
    }, { traceDecisions: true }).decisionTrace?.[0].disposition).toBe(
      "MISSING_DECISION",
    );
    expect(verifySemanticOutput(input, {
      schemaVersion: "1",
      decisions: [{
        candidateId: "related",
        impact: "yes",
        confidence: 0.9,
        summary: "Invalid impact value.",
        changedExcerpt: null,
        candidateExcerpt: null,
      }],
    }, { traceDecisions: true }).decisionTrace?.[0].disposition).toBe(
      "INVALID_DECISION",
    );
    expect(verifySemanticOutput(input, {
      schemaVersion: "2",
      decisions: [],
    }, { traceDecisions: true }).decisionTrace?.[0].disposition).toBe(
      "OUTPUT_SCHEMA_INVALID",
    );
  });
});

describe("semantic analyzer fallback", () => {
  it("records successful analyzer usage after validating the output", async () => {
    const input = buildSemanticAnalysisInput(
      "run-1",
      changed,
      generateSemanticCandidates(changed, [related]),
    );
    const result = await executeSemanticAnalysis(input, {
      name: "test-analyzer",
      model: "test-model",
      analyze: async () => ({
        output: {
          schemaVersion: "1",
          decisions: [{
            candidateId: "related",
            impact: true,
            confidence: 0.91,
            summary: "Both sources specify the same retry behavior.",
            changedExcerpt: "retries three times",
            candidateExcerpt: "retry three times",
          }],
        },
        usage: {
          promptTokens: 120,
          completionTokens: 40,
          estimatedCostMicros: 35,
        },
      }),
    });
    expect(result).toEqual(expect.objectContaining({
      status: "succeeded",
      accepted: [expect.objectContaining({ candidateId: "related" })],
      usage: { promptTokens: 120, completionTokens: 40, estimatedCostMicros: 35 },
    }));
    expect(result.decisionTrace).toBeUndefined();
  });

  it("keeps verified threshold decisions accepted even when retrieval support is weak", async () => {
    const input = buildSemanticAnalysisInput(
      "run-trace",
      changed,
      generateSemanticCandidates(changed, [related]),
    );
    const analyzerOutput = (confidence: number) => ({
      name: "test-analyzer",
      model: "test-model",
      analyze: async () => ({
        output: {
          schemaVersion: "1",
          decisions: [{
            candidateId: "related",
            impact: true,
            confidence,
            summary: "Both sources specify the same retry behavior.",
            changedExcerpt: "retries three times",
            candidateExcerpt: "retry three times",
          }],
        },
        usage: {
          promptTokens: 1,
          completionTokens: 1,
          estimatedCostMicros: null,
        },
      }),
    });

    const accepted = await executeSemanticAnalysis(
      input,
      analyzerOutput(0.95),
      { traceDecisions: true },
    );
    expect(accepted.decisionTrace).toEqual([
      expect.objectContaining({
        candidateId: "related",
        disposition: "ACCEPTED",
        evidenceStatus: "VERIFIED",
        combinedConfidence: expect.any(Number),
      }),
    ]);

    const lowSignalInput = {
      ...input,
      candidates: input.candidates.map((candidate) => ({
        ...candidate,
        lexicalScore: 0.12,
      })),
    };
    const acceptedAtThreshold = await executeSemanticAnalysis(
      lowSignalInput,
      analyzerOutput(0.78),
      { traceDecisions: true },
    );
    expect(acceptedAtThreshold.decisionTrace).toEqual([
      expect.objectContaining({
        candidateId: "related",
        disposition: "ACCEPTED",
        evidenceStatus: "VERIFIED",
        combinedConfidence: 0.78,
      }),
    ]);
  });

  it("preserves deterministic operation when no analyzer is configured", async () => {
    const input = buildSemanticAnalysisInput(
      "run-1",
      changed,
      generateSemanticCandidates(changed, [related]),
    );
    await expect(executeSemanticAnalysis(input)).resolves.toEqual(
      expect.objectContaining({
        status: "fallback",
        accepted: [],
        failureReason: "SEMANTIC_ANALYZER_NOT_CONFIGURED",
      }),
    );
  });

  it("marks every candidate as analyzer fallback in evaluation traces", async () => {
    const input = buildSemanticAnalysisInput(
      "run-trace",
      changed,
      generateSemanticCandidates(changed, [related]),
    );
    const result = await executeSemanticAnalysis(
      input,
      undefined,
      { traceDecisions: true },
    );
    expect(result.decisionTrace).toEqual([
      expect.objectContaining({
        candidateId: "related",
        disposition: "ANALYZER_FALLBACK",
      }),
    ]);
  });

  it("turns analyzer outages into a truthful fallback result", async () => {
    const input = buildSemanticAnalysisInput(
      "run-1",
      changed,
      generateSemanticCandidates(changed, [related]),
    );
    const result = await executeSemanticAnalysis(input, {
      name: "test-analyzer",
      model: "test-model",
      analyze: async () => {
        throw new Error("model unavailable");
      },
    });
    expect(result).toEqual(expect.objectContaining({
      status: "fallback",
      accepted: [],
      failureReason: "model unavailable",
    }));
  });
});
