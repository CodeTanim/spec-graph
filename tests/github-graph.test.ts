import { describe, expect, it } from "vitest";
import {
  classifyGitHubArtifact,
  extractDeterministicReferences,
  extractOpenApiEndpoints,
  parseArtifactGraph,
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
import { rankDeterministicCandidates } from "../lib/analysis/candidates";

describe("GitHub artifact indexing", () => {
  it("keeps the supported MVP surface small and predictable", () => {
    expect(classifyGitHubArtifact("src/refunds/policy.ts")).toBe("code");
    expect(classifyGitHubArtifact("tests/refunds.test.ts")).toBe("test");
    expect(classifyGitHubArtifact("docs/refunds.mdx")).toBe("markdown");
    expect(classifyGitHubArtifact("api/openapi.yaml")).toBe("openapi");
    expect(classifyGitHubArtifact(".agents/skills/supabase/SKILL.md")).toBeNull();
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

  it("normalizes import, export, alias, and test naming relationships", () => {
    const knownPaths = new Set([
      "src/config.ts",
      "src/refunds.ts",
      "tests/refunds.spec.ts",
    ]);
    const codeReferences = extractDeterministicReferences(
      "src/refunds.ts",
      "code",
      'import "./config";\nexport { settings } from "@/src/config.js";',
      knownPaths,
      new Map(),
    );
    expect(codeReferences).toEqual([
      expect.objectContaining({
        targetPath: "src/config.ts",
        type: "imports",
        confidence: 1,
      }),
    ]);

    const testReferences = extractDeterministicReferences(
      "tests/refunds.spec.ts",
      "test",
      'describe("refunds", () => {});',
      knownPaths,
      new Map(),
    );
    expect(testReferences).toContainEqual(
      expect.objectContaining({
        targetPath: "src/refunds.ts",
        type: "tests",
        confidence: 0.86,
      }),
    );
  });

  it("returns a common parser shape with stable Markdown sections", () => {
    const parsed = parseArtifactGraph(
      "docs/refunds.md",
      "markdown",
      "# Refunds\n\nIntro.\n\n## Policy\n\nSee [implementation](../src/refunds.ts).",
      new Set(["docs/refunds.md", "src/refunds.ts"]),
      new Map(),
    );
    expect(parsed.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stableKey: "file:docs/refunds.md",
          kind: "doc_section",
        }),
        expect.objectContaining({
          stableKey: "section:docs/refunds.md#refunds:1",
          name: "Refunds",
          startLine: 1,
          endLine: 4,
        }),
        expect.objectContaining({
          stableKey: "section:docs/refunds.md#policy:1",
          name: "Policy",
          startLine: 5,
        }),
      ]),
    );
    expect(parsed.references).toContainEqual(
      expect.objectContaining({
        targetPath: "src/refunds.ts",
        type: "links",
        evidenceStartLine: 7,
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
        Array.from({ length: 160 }, () => ({ size: 1 })),
      ),
    ).not.toThrow();
    expect(() =>
      assertRepositoryWithinLimits(
        Array.from({ length: 161 }, () => ({ size: 1 })),
      ),
    ).toThrow("up to 160 supported files");
  });
});

describe("deterministic candidate ranking", () => {
  const nodes = [
    { nodeId: "changed", artifactId: "art_changed", kind: "code" as const, path: "src/core.ts" },
    { nodeId: "wrapper", artifactId: "art_wrapper", kind: "code" as const, path: "src/wrapper.ts" },
    { nodeId: "guide", artifactId: "art_guide", kind: "markdown" as const, path: "docs/guide.md" },
    { nodeId: "secondary", artifactId: "art_secondary", kind: "confluence" as const, path: "ENG/Guide" },
    { nodeId: "unrelated", artifactId: "art_unrelated", kind: "markdown" as const, path: "docs/orders.md" },
  ];
  const edge = (
    id: string,
    fromNodeId: string,
    toNodeId: string,
    type: string,
  ) => ({
    id,
    fromNodeId,
    toNodeId,
    type,
    origin: "deterministic" as const,
    confidence: 1,
    evidence: `${fromNodeId} ${type} ${toNodeId}`,
    evidenceStartLine: 1,
  });

  it("finds an explicit documentation impact through one code neighbor", () => {
    const ranked = rankDeterministicCandidates(
      [{ id: "changed", path: "src/core.ts" }],
      nodes,
      [
        edge("imports", "wrapper", "changed", "imports"),
        edge("guide", "guide", "wrapper", "links"),
      ],
    );
    expect(ranked).toEqual([
      expect.objectContaining({
        changedNodeId: "changed",
        affectedNodeId: "guide",
        depth: 2,
        viaNodeIds: ["wrapper"],
        score: 0.7568,
      }),
    ]);
  });

  it("stops after the first documentation boundary and excludes unrelated files", () => {
    const ranked = rankDeterministicCandidates(
      [{ id: "changed", path: "src/core.ts" }],
      nodes,
      [
        edge("guide", "guide", "changed", "links"),
        edge("secondary", "secondary", "guide", "documents"),
      ],
    );
    expect(ranked.map((candidate) => candidate.affectedNodeId)).toEqual(["guide"]);
  });

  it("allows documentation changes to reach code and other documentation", () => {
    const ranked = rankDeterministicCandidates(
      [{ id: "guide", path: "docs/guide.md" }],
      nodes,
      [
        edge("guide-code", "guide", "changed", "links"),
        edge("guide-doc", "secondary", "guide", "documents"),
      ],
    );
    expect(new Set(ranked.map((candidate) => candidate.affectedNodeId))).toEqual(
      new Set(["changed", "secondary"]),
    );
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

  it("allows documentation changes to flag primary code and other documentation", () => {
    expect(shouldCreateImpactFinding("confluence", "code")).toBe(true);
    expect(shouldCreateImpactFinding("markdown", "test")).toBe(false);
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
