import { describe, expect, it } from "vitest";
import { discoverEntityRelationships } from "../lib/graph/entity-relationships";

describe("entity relationship discovery", () => {
  it("connects an exact documented identifier to its defining symbol", () => {
    const relationships = discoverEntityRelationships([
      {
        artifactId: "code",
        sourceId: "github",
        kind: "code",
        path: "src/payments.ts",
        rootNodeId: "code-root",
        text: "export class PaymentService {}",
        entityNodeIds: new Map([["identifier:paymentservice", "payment-symbol"]]),
      },
      {
        artifactId: "doc",
        sourceId: "confluence",
        kind: "confluence",
        path: "PAY/Architecture",
        rootNodeId: "doc-root",
        text: "PaymentService owns payment authorization.",
      },
    ]);
    expect(relationships).toContainEqual(expect.objectContaining({
      fromNodeId: "doc-root",
      toNodeId: "payment-symbol",
      type: "mentions_entity:identifier:paymentservice",
      provenance: "EXACT_IDENTIFIER",
      confidence: 0.95,
      evidence: "PaymentService owns payment authorization.",
    }));
  });

  it("connects an exact documented operation to its OpenAPI endpoint", () => {
    const relationships = discoverEntityRelationships([
      {
        artifactId: "contract",
        sourceId: "github",
        kind: "openapi",
        path: "openapi.yaml",
        rootNodeId: "contract-root",
        text: "openapi: 3.0.0\npaths:\n  /payments:\n    post:\n      responses: {}",
        entityNodeIds: new Map([["endpoint:post /payments", "endpoint-node"]]),
      },
      {
        artifactId: "doc",
        sourceId: "confluence",
        kind: "confluence",
        path: "PAY/API",
        rootNodeId: "doc-root",
        text: "Call POST /payments to authorize a payment.",
      },
    ]);
    expect(relationships).toContainEqual(expect.objectContaining({
      fromNodeId: "doc-root",
      toNodeId: "endpoint-node",
      provenance: "OPENAPI_ENTITY",
      confidence: 0.98,
    }));
  });

  it("creates symmetric doc-to-doc edges only for strong shared entities", () => {
    const relationships = discoverEntityRelationships([
      {
        artifactId: "confluence-doc",
        sourceId: "confluence",
        kind: "confluence",
        path: "PAY/Architecture",
        rootNodeId: "confluence-node",
        text: "PaymentService sends PaymentStatus events.",
      },
      {
        artifactId: "markdown-doc",
        sourceId: "github",
        kind: "markdown",
        path: "docs/payments.md",
        rootNodeId: "markdown-node",
        text: "PaymentService owns the PaymentStatus lifecycle.",
      },
      {
        artifactId: "unrelated-doc",
        sourceId: "other",
        kind: "confluence",
        path: "OPS/Deployments",
        rootNodeId: "unrelated-node",
        text: "Deploy the web application each morning.",
      },
    ]);
    const shared = relationships.filter((relationship) =>
      relationship.provenance === "SHARED_ENTITY",
    );
    expect(shared).toHaveLength(2);
    expect(new Set(shared.map((relationship) => relationship.fromNodeId))).toEqual(
      new Set(["confluence-node", "markdown-node"]),
    );
    expect(shared.some((relationship) => relationship.toNodeId === "unrelated-node")).toBe(false);
  });
});
