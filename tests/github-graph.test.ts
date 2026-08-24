import { describe, expect, it } from "vitest";
import {
  classifyGitHubArtifact,
  extractDeterministicReferences,
  extractOpenApiEndpoints,
} from "../lib/github/artifacts";
import { assertRepositoryWithinLimits } from "../lib/github/limits";
import { parsePullRequestNumber } from "../lib/github/targets";
import {
  relationshipReason,
  shouldCreateImpactFinding,
} from "../lib/analysis/deterministic";
import {
  diffOpenApiContracts,
  parseOpenApiContract,
} from "../lib/openapi/parser";

describe("GitHub artifact indexing", () => {
  it("keeps the supported MVP surface small and predictable", () => {
    expect(classifyGitHubArtifact("src/refunds/policy.ts")).toBe("code");
    expect(classifyGitHubArtifact("tests/refunds.test.ts")).toBe("test");
    expect(classifyGitHubArtifact("docs/refunds.mdx")).toBe("markdown");
    expect(classifyGitHubArtifact("api/openapi.yaml")).toBe("openapi");
    expect(classifyGitHubArtifact("node_modules/pkg/index.ts")).toBeNull();
    expect(classifyGitHubArtifact("assets/logo.png")).toBeNull();
  });

  it("creates explainable edges from imports, links, paths, and endpoints", () => {
    const knownPaths = new Set([
      "src/refunds/policy.ts",
      "tests/refunds.test.ts",
      "docs/refunds.md",
      "api/openapi.yaml",
    ]);
    const openApi = "openapi: 3.0.0\npaths:\n  /refunds:\n    post:\n      responses: {}";
    const contracts = new Map([
      ["api/openapi.yaml", [parseOpenApiContract(openApi)]],
    ]);
    const testReferences = extractDeterministicReferences(
      "tests/refunds.test.ts",
      "test",
      'import { window } from "../src/refunds/policy";\nfetch("/refunds");',
      knownPaths,
      contracts,
    );
    expect(testReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetPath: "src/refunds/policy.ts",
          type: "references",
        }),
        expect.objectContaining({
          targetPath: "api/openapi.yaml",
          type: "covers_openapi:path:/refunds",
        }),
      ]),
    );

    const docReferences = extractDeterministicReferences(
      "docs/refunds.md",
      "markdown",
      "# Refunds\n\n[Policy implementation](../src/refunds/policy.ts)",
      knownPaths,
      contracts,
    );
    expect(docReferences).toContainEqual(
      expect.objectContaining({
        targetPath: "src/refunds/policy.ts",
        type: "links",
        evidence: "[Policy implementation](../src/refunds/policy.ts)",
        evidenceStartLine: 3,
      }),
    );
  });

  it("extracts OpenAPI endpoints from JSON and YAML contracts", () => {
    expect(
      extractOpenApiEndpoints(
        '{"openapi":"3.0.0","paths":{"/users":{"post":{"responses":{}}}}}',
      ),
    ).toEqual(["/users"]);
    expect(
      extractOpenApiEndpoints(
        "openapi: 3.0.0\npaths:\n  /refunds:\n    post:\n      responses: {}",
      ),
    ).toEqual(["/refunds"]);
  });

  it("turns schema changes into exact facts and propagates them to using operations", () => {
    const before = `openapi: 3.0.0
paths:
  /users:
    post:
      requestBody:
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/User'
      responses: {}
components:
  schemas:
    User:
      type: object
      required: [name]
      properties:
        name: { type: string }
        email: { type: string }
`;
    const after = before.replace("required: [name]", "required: [name, email]");
    const changes = diffOpenApiContracts(before, after);
    expect(changes).toContainEqual(
      expect.objectContaining({
        stableKey: "schema:User",
        summary: "User: email is now required.",
        matchKeys: expect.arrayContaining([
          "schema:User",
          "operation:POST:/users",
          "path:/users",
        ]),
      }),
    );
  });

  it("ignores formatting-only OpenAPI edits", () => {
    expect(
      diffOpenApiContracts(
        '{"openapi":"3.0.0","paths":{"/users":{"get":{"responses":{}}}}}',
        "openapi: 3.0.0\npaths:\n  /users:\n    get:\n      responses: {}\n",
      ),
    ).toEqual([]);
  });

  it("accepts repositories the size of the SpecGraph demo while retaining a bounded cap", () => {
    expect(() =>
      assertRepositoryWithinLimits(
        Array.from({ length: 86 }, () => ({ size: 25_000 })),
      ),
    ).not.toThrow();
    expect(() =>
      assertRepositoryWithinLimits(
        Array.from({ length: 121 }, () => ({ size: 1 })),
      ),
    ).toThrow("up to 120 supported files");
  });
});

describe("GitHub pull request targets", () => {
  it("accepts a number or a matching GitHub URL", () => {
    expect(parsePullRequestNumber("#42", "acme/platform-api")).toBe(42);
    expect(
      parsePullRequestNumber(
        "https://github.com/acme/platform-api/pull/91",
        "acme/platform-api",
      ),
    ).toBe(91);
  });

  it("rejects pull requests from a different repository", () => {
    expect(() =>
      parsePullRequestNumber(
        "https://github.com/other/project/pull/91",
        "acme/platform-api",
      ),
    ).toThrow("Enter a pull request number");
  });
});

describe("directional impact policy", () => {
  it("keeps ordinary code-to-code import neighbors out of the update feed", () => {
    expect(shouldCreateImpactFinding("code", "code")).toBe(false);
    expect(shouldCreateImpactFinding("code", "test")).toBe(false);
    expect(shouldCreateImpactFinding("test", "code")).toBe(false);
  });

  it("allows code changes to flag linked documentation", () => {
    expect(shouldCreateImpactFinding("code", "markdown")).toBe(true);
    expect(shouldCreateImpactFinding("code", "openapi")).toBe(true);
    expect(shouldCreateImpactFinding("code", "confluence")).toBe(true);
  });

  it("allows documentation changes to flag code, tests, and other documentation", () => {
    expect(shouldCreateImpactFinding("confluence", "code")).toBe(true);
    expect(shouldCreateImpactFinding("markdown", "test")).toBe(true);
    expect(shouldCreateImpactFinding("confluence", "markdown")).toBe(true);
    expect(shouldCreateImpactFinding("markdown", "confluence")).toBe(true);
  });

  it("keeps OpenAPI changes focused on human-facing documentation", () => {
    expect(shouldCreateImpactFinding("openapi", "confluence")).toBe(true);
    expect(shouldCreateImpactFinding("openapi", "markdown")).toBe(true);
    expect(shouldCreateImpactFinding("openapi", "code")).toBe(false);
    expect(shouldCreateImpactFinding("openapi", "test")).toBe(false);
  });

  it("describes the relationship from the actual referring side", () => {
    expect(
      relationshipReason(
        "references",
        "docs/WEBHOOK_SMOKE_TEST.md",
        "markdown",
        "code",
        true,
      ),
    ).toBe(
      "The changed file docs/WEBHOOK_SMOKE_TEST.md references this file.",
    );
    expect(
      relationshipReason(
        "documents",
        "src/policy.ts",
        "code",
        "markdown",
        false,
      ),
    ).toBe("This file references the changed file src/policy.ts.");
  });
});
