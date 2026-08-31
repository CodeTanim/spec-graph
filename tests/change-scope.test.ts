import { describe, expect, it } from "vitest";
import {
  MAX_ANALYSIS_SCOPES_PER_ARTIFACT,
  MAX_ANALYSIS_SCOPES_PER_EVENT,
  deriveAnalysisScopes,
  deriveAnalysisScopesFromUnifiedPatch,
  parseAnalysisScopes,
  semanticSnapshotForScope,
  serializeAnalysisScopes,
} from "../lib/analysis/change-scope";

const base = {
  artifactId: "artifact-policy",
  path: "src/policy.ts",
  kind: "code" as const,
  beforeRevision: "before-sha",
  afterRevision: "after-sha",
};

describe("provider-neutral analysis scopes", () => {
  it("keeps separated edits atomic with original line numbers", () => {
    const scopes = deriveAnalysisScopes({
      ...base,
      beforeText: ["one", "retryLimit = 2", "three", "four", "timeout = 10"].join("\n"),
      afterText: ["one", "retryLimit = 3", "three", "four", "timeout = 20"].join("\n"),
    });

    expect(scopes).toHaveLength(2);
    expect(scopes[0]).toMatchObject({
      status: "available",
      changeType: "modified",
      beforeStartLine: 2,
      beforeEndLine: 2,
      afterStartLine: 2,
      afterEndLine: 2,
      beforeText: "retryLimit = 2",
      afterText: "retryLimit = 3",
    });
    expect(scopes[0]?.semanticText).toBe(
      "Before:\nretryLimit = 2\n\nAfter:\nretryLimit = 3",
    );
    expect(scopes[1]).toMatchObject({
      beforeStartLine: 5,
      afterStartLine: 5,
      beforeText: "timeout = 10",
      afterText: "timeout = 20",
    });
  });

  it("represents additions and deletions without inventing the missing side", () => {
    const added = deriveAnalysisScopes({
      ...base,
      beforeRevision: null,
      beforeText: null,
      afterText: "export const enabled = true;",
    });
    const deleted = deriveAnalysisScopes({
      ...base,
      afterRevision: null,
      beforeText: "export const legacy = true;",
      afterText: null,
    });

    expect(added[0]).toMatchObject({
      changeType: "added",
      beforeStartLine: null,
      afterStartLine: 1,
      semanticText: "Added:\nexport const enabled = true;",
    });
    expect(deleted[0]).toMatchObject({
      changeType: "deleted",
      beforeStartLine: 1,
      afterStartLine: null,
      semanticText: "Removed:\nexport const legacy = true;",
    });
  });

  it("fails closed when an expected version body is missing", () => {
    const scopes = deriveAnalysisScopes({
      ...base,
      beforeText: null,
      afterText: "retryLimit = 3",
    });

    expect(scopes).toEqual([
      expect.objectContaining({
        status: "unavailable",
        reason: "missing_before_version",
        semanticText: "",
      }),
    ]);
  });

  it("bounds large or numerous changes and records the loss explicitly", () => {
    const before = Array.from({ length: 20 }, (_, index) => `old-${index}`).join("\n");
    const after = Array.from({ length: 20 }, (_, index) => `new-${index}`).join("\n");
    const scopes = deriveAnalysisScopes({ ...base, beforeText: before, afterText: after });
    expect(scopes.length).toBeLessThanOrEqual(MAX_ANALYSIS_SCOPES_PER_ARTIFACT);

    const large = deriveAnalysisScopes({
      ...base,
      beforeText: "a".repeat(4_000),
      afterText: "b".repeat(4_000),
    });
    expect(large[0]).toMatchObject({ truncated: true });
    expect(large[0]!.beforeText.length).toBeLessThanOrEqual(2_400);
    expect(large[0]!.afterText.length).toBeLessThanOrEqual(2_400);
  });

  it("converts a GitHub unified patch into exact source-side ranges", () => {
    const scopes = deriveAnalysisScopesFromUnifiedPatch({
      ...base,
      patch: [
        "@@ -10,3 +10,3 @@",
        " unchanged",
        "-retryLimit = 2",
        "+retryLimit = 3",
        " unchanged again",
      ].join("\n"),
    });

    expect(scopes).toEqual([
      expect.objectContaining({
        beforeStartLine: 11,
        afterStartLine: 11,
        beforeText: "retryLimit = 2",
        afterText: "retryLimit = 3",
      }),
    ]);
  });

  it("round-trips valid private scopes and applies only a matching scope", () => {
    const [scope] = deriveAnalysisScopes({
      ...base,
      beforeText: "retryLimit = 2",
      afterText: "retryLimit = 3",
    });
    const parsed = parseAnalysisScopes(serializeAnalysisScopes([scope!]));
    const snapshot = {
      nodeId: "node-policy",
      artifactId: "artifact-policy",
      kind: "code" as const,
      path: "src/policy.ts",
      revision: "after-sha",
      sourceUrl: null,
      text: "unrelated whole-file text",
    };

    expect(parsed).toHaveLength(1);
    expect(semanticSnapshotForScope(snapshot, parsed[0]!)?.text).toBe(
      "Before:\nretryLimit = 2\n\nAfter:\nretryLimit = 3",
    );
    expect(
      semanticSnapshotForScope({ ...snapshot, path: "src/other.ts" }, parsed[0]!),
    ).toBeNull();
  });

  it("caps the private event payload across many changed artifacts", () => {
    const scopes = Array.from({ length: 30 }, (_, index) =>
      deriveAnalysisScopes({
        ...base,
        artifactId: `artifact-${index}`,
        path: `src/file-${index}.ts`,
        beforeText: "oldValue = 1",
        afterText: "newValue = 2",
      })[0]!,
    );
    const parsed = parseAnalysisScopes(serializeAnalysisScopes(scopes));
    expect(parsed.filter((scope) => scope.status === "available")).toHaveLength(
      MAX_ANALYSIS_SCOPES_PER_EVENT,
    );
    expect(parsed.filter((scope) => scope.status === "unavailable")).toHaveLength(
      scopes.length - MAX_ANALYSIS_SCOPES_PER_EVENT,
    );
    expect(
      parsed
        .filter((scope) => scope.status === "unavailable")
        .every((scope) => scope.truncated && scope.reason === "event_limit"),
    ).toBe(true);
    expect(new Set(parsed.map((scope) => scope.path)).size).toBe(scopes.length);
  });

  it("rejects malformed persisted scopes before they reach semantic analysis", () => {
    const [scope] = deriveAnalysisScopes({
      ...base,
      beforeText: "retryLimit = 2",
      afterText: "retryLimit = 3",
    });
    const malformed = { ...scope, beforeStartLine: -4 };

    expect(parseAnalysisScopes(JSON.stringify([malformed]))).toEqual([]);
  });
});
