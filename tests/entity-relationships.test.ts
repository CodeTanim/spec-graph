import { describe, expect, it } from "vitest";
import {
  extractCodeDefinitions,
  extractDocumentMentions,
  extractOpenApiDefinitions,
} from "../lib/graph/entities";
import { parseArtifactGraph } from "../lib/graph/parser";

describe("fine-grained entity extraction", () => {
  it("extracts stable code definitions with line evidence", () => {
    const entities = extractCodeDefinitions(
      "export interface PaymentStatus {}\nexport class PaymentService {}\nconst local = true;",
    );
    expect(entities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "identifier:paymentstatus",
        label: "PaymentStatus",
        role: "defines",
        line: 1,
      }),
      expect.objectContaining({
        key: "identifier:paymentservice",
        label: "PaymentService",
        role: "defines",
        line: 2,
      }),
    ]));
    expect(entities.some((entity) => entity.label === "local")).toBe(false);
  });

  it("extracts exact identifiers and HTTP operations from documentation", () => {
    const entities = extractDocumentMentions(
      "PaymentService submits POST /payments before returning PaymentStatus.",
    );
    expect(entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "identifier:paymentservice", line: 1 }),
      expect.objectContaining({ key: "identifier:paymentstatus", line: 1 }),
      expect.objectContaining({ key: "endpoint:post /payments", confidence: 0.98 }),
    ]));
  });

  it("maps OpenAPI operations and schemas to definition entities", () => {
    const entities = extractOpenApiDefinitions(`openapi: 3.0.0
paths:
  /payments:
    post:
      responses: {}
components:
  schemas:
    PaymentStatus:
      type: string
`);
    expect(entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "endpoint:post /payments", role: "defines" }),
      expect.objectContaining({ key: "identifier:paymentstatus", role: "defines" }),
    ]));
  });

  it("creates addressable symbol and endpoint graph nodes", () => {
    const code = parseArtifactGraph(
      "src/payments.ts",
      "code",
      "export class PaymentService {}",
      new Set(["src/payments.ts"]),
      new Map(),
    );
    expect(code.nodes).toContainEqual(expect.objectContaining({
      stableKey: "entity:identifier:paymentservice",
      kind: "symbol",
      name: "PaymentService",
    }));

    const openapi = parseArtifactGraph(
      "openapi.yaml",
      "openapi",
      "openapi: 3.0.0\npaths:\n  /payments:\n    post:\n      responses: {}",
      new Set(["openapi.yaml"]),
      new Map(),
    );
    expect(openapi.nodes).toContainEqual(expect.objectContaining({
      stableKey: "entity:endpoint:post /payments",
      kind: "endpoint",
    }));
  });
});
