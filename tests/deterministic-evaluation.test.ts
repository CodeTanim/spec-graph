import { describe, expect, it } from "vitest";
import {
  rankDeterministicCandidates,
  type CandidateEdge,
  type CandidateNode,
} from "../lib/analysis/candidates";
import { calculateEvaluationMetrics } from "../lib/analysis/evaluation";

type GoldenCase = {
  name: string;
  changed: { id: string; path: string; changeKeys?: string[] };
  nodes: CandidateNode[];
  edges: CandidateEdge[];
  expected: string[];
};

function edge(
  id: string,
  fromNodeId: string,
  toNodeId: string,
  type: string,
): CandidateEdge {
  return {
    id,
    fromNodeId,
    toNodeId,
    type,
    origin: "deterministic",
    confidence: 1,
    evidence: `${fromNodeId} ${type} ${toNodeId}`,
    evidenceStartLine: 1,
  };
}

const goldenCases: GoldenCase[] = [
  {
    name: "code to directly linked repository documentation",
    changed: { id: "code", path: "src/refunds.ts" },
    nodes: [
      { nodeId: "code", artifactId: "a-code", kind: "code", path: "src/refunds.ts" },
      { nodeId: "guide", artifactId: "a-guide", kind: "markdown", path: "docs/refunds.md" },
      { nodeId: "orders", artifactId: "a-orders", kind: "markdown", path: "docs/orders.md" },
    ],
    edges: [edge("guide-code", "guide", "code", "links")],
    expected: ["guide"],
  },
  {
    name: "code to documentation through one imported wrapper",
    changed: { id: "core", path: "src/core.ts" },
    nodes: [
      { nodeId: "core", artifactId: "a-core", kind: "code", path: "src/core.ts" },
      { nodeId: "wrapper", artifactId: "a-wrapper", kind: "code", path: "src/wrapper.ts" },
      { nodeId: "guide", artifactId: "a-guide", kind: "confluence", path: "ENG/Core guide" },
      { nodeId: "other", artifactId: "a-other", kind: "confluence", path: "ENG/Other" },
    ],
    edges: [
      edge("wrapper-core", "wrapper", "core", "imports"),
      edge("guide-wrapper", "guide", "wrapper", "documents"),
    ],
    expected: ["guide"],
  },
  {
    name: "documentation to code and peer documentation",
    changed: { id: "policy", path: "docs/policy.md" },
    nodes: [
      { nodeId: "policy", artifactId: "a-policy", kind: "markdown", path: "docs/policy.md" },
      { nodeId: "code", artifactId: "a-code", kind: "code", path: "src/policy.ts" },
      { nodeId: "peer", artifactId: "a-peer", kind: "confluence", path: "ENG/Policy" },
      { nodeId: "other", artifactId: "a-other", kind: "code", path: "src/orders.ts" },
    ],
    edges: [
      edge("policy-code", "policy", "code", "links"),
      edge("peer-policy", "peer", "policy", "documents"),
    ],
    expected: ["code", "peer"],
  },
  {
    name: "OpenAPI operation change to only matching human documentation",
    changed: {
      id: "openapi",
      path: "api/openapi.yaml",
      changeKeys: ["operation:POST:/users", "path:/users"],
    },
    nodes: [
      { nodeId: "openapi", artifactId: "a-api", kind: "openapi", path: "api/openapi.yaml" },
      { nodeId: "users", artifactId: "a-users", kind: "markdown", path: "docs/users.md" },
      { nodeId: "orders", artifactId: "a-orders", kind: "markdown", path: "docs/orders.md" },
    ],
    edges: [
      edge("users-api", "users", "openapi", "covers_openapi:operation:POST:/users"),
      edge("orders-api", "orders", "openapi", "covers_openapi:operation:GET:/orders"),
    ],
    expected: ["users"],
  },
  {
    name: "unrelated code change",
    changed: { id: "code", path: "src/metrics.ts" },
    nodes: [
      { nodeId: "code", artifactId: "a-code", kind: "code", path: "src/metrics.ts" },
      { nodeId: "guide", artifactId: "a-guide", kind: "markdown", path: "docs/refunds.md" },
    ],
    edges: [],
    expected: [],
  },
];

describe("deterministic golden evaluation", () => {
  it.each(goldenCases)("matches $name", (golden) => {
    const predicted = rankDeterministicCandidates(
      [golden.changed],
      golden.nodes,
      golden.edges,
    ).map((candidate) => candidate.affectedNodeId);
    expect(new Set(predicted)).toEqual(new Set(golden.expected));
  });

  it("reports perfect precision and recall on the reviewed starter set", () => {
    const results = goldenCases.map((golden) => ({
      expected: golden.expected,
      predicted: rankDeterministicCandidates(
        [golden.changed],
        golden.nodes,
        golden.edges,
      ).map((candidate) => candidate.affectedNodeId),
      candidateUniverse: golden.nodes
        .map((node) => node.nodeId)
        .filter((nodeId) => nodeId !== golden.changed.id),
    }));
    expect(calculateEvaluationMetrics(results)).toEqual({
      truePositives: 5,
      falsePositives: 0,
      falseNegatives: 0,
      trueNegatives: 6,
      precision: 1,
      recall: 1,
      f1: 1,
      falsePositiveRate: 0,
    });
  });
});
