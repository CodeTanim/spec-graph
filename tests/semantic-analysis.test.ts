import { describe, expect, it } from "vitest";
import {
  buildSemanticAnalysisInput,
  combinedSemanticConfidence,
  executeSemanticAnalysis,
  generateSemanticCandidates,
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
