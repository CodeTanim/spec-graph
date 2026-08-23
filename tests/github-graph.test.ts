import { describe, expect, it } from "vitest";
import {
  classifyGitHubArtifact,
  extractDeterministicReferences,
  extractOpenApiEndpoints,
} from "../lib/github/artifacts";
import { assertRepositoryWithinLimits } from "../lib/github/limits";
import { parsePullRequestNumber } from "../lib/github/targets";

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
    const endpoints = new Map([
      ["api/openapi.yaml", extractOpenApiEndpoints("paths:\n  /refunds:\n    post:")],
    ]);
    const testReferences = extractDeterministicReferences(
      "tests/refunds.test.ts",
      "test",
      'import { window } from "../src/refunds/policy";\nfetch("/refunds");',
      knownPaths,
      endpoints,
    );
    expect(testReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetPath: "src/refunds/policy.ts",
          type: "references",
        }),
        expect.objectContaining({
          targetPath: "api/openapi.yaml",
          type: "covers_endpoint",
        }),
      ]),
    );

    const docReferences = extractDeterministicReferences(
      "docs/refunds.md",
      "markdown",
      "[Policy implementation](../src/refunds/policy.ts)",
      knownPaths,
      endpoints,
    );
    expect(docReferences).toContainEqual(
      expect.objectContaining({
        targetPath: "src/refunds/policy.ts",
        type: "links",
      }),
    );
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
