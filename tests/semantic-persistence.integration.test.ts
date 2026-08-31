import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SpecGraphDb } from "../db";
import * as schema from "../db/schema";
import {
  analysisRuns,
  artifactVersions,
  artifacts,
  findingEvidence,
  findings,
  graphNodes,
  relationships,
  semanticAnalysisAttempts,
  sources,
  workspaces,
} from "../db/schema";
import { executeAndPersistSemanticAnalysis } from "../lib/analysis/semantic-persistence";
import { deriveAnalysisScopes } from "../lib/analysis/change-scope";

let client: PGlite;
let db: SpecGraphDb;

beforeEach(async () => {
  client = new PGlite();
  const testDb = drizzle(client, { schema });
  await migrate(testDb, { migrationsFolder: "drizzle-postgres" });
  db = testDb as unknown as SpecGraphDb;
});

afterEach(async () => {
  await client.close();
});

describe("semantic finding persistence", () => {
  it("stores only source-verified findings plus analyzer telemetry", async () => {
    const now = new Date().toISOString();
    await db.insert(workspaces).values({
      id: "ws_semantic",
      name: "Semantic workspace",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(sources).values({
      id: "src_semantic",
      workspaceId: "ws_semantic",
      provider: "github",
      externalId: "repo-semantic",
      name: "acme/payments",
      detail: "main",
      status: "connected",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(artifacts).values([
      {
        id: "artifact_changed",
        sourceId: "src_semantic",
        externalId: "src/retry.ts",
        kind: "code",
        path: "src/retry.ts",
        title: "retry.ts",
        canonicalUrl: "https://github.com/acme/payments/blob/abc/src/retry.ts",
        currentRevision: "abc",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "artifact_candidate",
        sourceId: "src_semantic",
        externalId: "docs/retries.md",
        kind: "markdown",
        path: "docs/retries.md",
        title: "Retry policy",
        canonicalUrl: "https://github.com/acme/payments/blob/abc/docs/retries.md",
        currentRevision: "abc",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(artifactVersions).values([
      {
        id: "version_changed",
        artifactId: "artifact_changed",
        revision: "abc",
        contentHash: "changed-hash",
        extractedText: "Payment authorization retries three times before failing.",
        createdAt: now,
      },
      {
        id: "version_candidate",
        artifactId: "artifact_candidate",
        revision: "abc",
        contentHash: "candidate-hash",
        extractedText: "Failed payment authorization requests retry three times.",
        createdAt: now,
      },
    ]);
    await db.insert(graphNodes).values([
      {
        id: "node_changed",
        artifactId: "artifact_changed",
        stableKey: "file:src/retry.ts",
        kind: "file",
        name: "src/retry.ts",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "node_candidate",
        artifactId: "artifact_candidate",
        stableKey: "file:docs/retries.md",
        kind: "file",
        name: "docs/retries.md",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(analysisRuns).values({
      id: "run_semantic",
      workspaceId: "ws_semantic",
      sourceId: "src_semantic",
      trigger: "manual",
      title: "Check retry behavior",
      target: "abc",
      status: "running",
      createdAt: now,
      updatedAt: now,
    });

    const [changedScope] = deriveAnalysisScopes({
      artifactId: "artifact_changed",
      path: "src/retry.ts",
      kind: "code",
      beforeRevision: "before-abc",
      afterRevision: "abc",
      beforeText: "Payment authorization retries two times before failing.",
      afterText: "Payment authorization retries three times before failing.",
    });
    let analyzedChangedText: string | null = null;
    const result = await executeAndPersistSemanticAnalysis({
      runId: "run_semantic",
      changed: {
        nodeId: "node_changed",
        artifactId: "artifact_changed",
        kind: "code",
        path: "src/retry.ts",
        revision: "abc",
        sourceUrl: "https://github.com/acme/payments/blob/abc/src/retry.ts",
        text: "Payment authorization retries three times before failing.",
      },
      changedScope,
      candidates: [{
        nodeId: "node_candidate",
        artifactId: "artifact_candidate",
        kind: "markdown",
        path: "docs/retries.md",
        revision: "abc",
        sourceUrl: "https://github.com/acme/payments/blob/abc/docs/retries.md",
        text: "Failed payment authorization requests retry three times.",
      }],
      analyzer: {
        name: "fixture-analyzer",
        model: "fixture-model",
        analyze: async (semanticInput) => {
          analyzedChangedText = semanticInput.changed.text;
          return {
            output: {
            schemaVersion: "1",
            decisions: [{
              candidateId: "node_candidate",
              impact: true,
              confidence: 0.9,
              summary: "Both sources describe the same retry behavior.",
              changedExcerpt: "retries three times",
              candidateExcerpt: "retry three times",
            }],
          },
            usage: {
              promptTokens: 100,
              completionTokens: 30,
              estimatedCostMicros: 20,
            },
          };
        },
      },
    }, db);

    expect(result.persistedFindings).toBe(1);
    expect(analyzedChangedText).toBe(
      "Before:\nPayment authorization retries two times before failing.\n\n" +
        "After:\nPayment authorization retries three times before failing.",
    );
    const persistedFindingRows = await db.select().from(findings);
    expect(persistedFindingRows).toEqual([
      expect.objectContaining({
        affectedNodeId: "node_candidate",
        origin: "semantic",
        provenance: "SEMANTIC",
      }),
    ]);
    expect(persistedFindingRows[0]?.confidence).toBeGreaterThanOrEqual(0.78);
    // Retrieval similarity admits the bounded candidate; after exact evidence
    // verification it must not silently demote the analyzer's confidence.
    expect(persistedFindingRows[0]?.confidence).toBe(0.9);
    expect(await db.select().from(findingEvidence)).toEqual([
      expect.objectContaining({
        artifactVersionId: "version_candidate",
        excerpt: "retry three times",
        type: "semantic",
      }),
    ]);
    expect(await db.select().from(relationships)).toEqual([
      expect.objectContaining({
        type: "semantic_impact",
        origin: "semantic",
        provenance: "SEMANTIC",
      }),
    ]);
    expect(await db.select().from(semanticAnalysisAttempts)).toEqual([
      expect.objectContaining({
        status: "succeeded",
        acceptedDecisionCount: 1,
        promptTokens: 100,
        estimatedCostMicros: 20,
      }),
    ]);
  });
});
