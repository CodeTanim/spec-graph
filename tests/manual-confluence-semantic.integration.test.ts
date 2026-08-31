import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpecGraphDb } from "../db";
import * as schema from "../db/schema";
import {
  analysisRuns,
  artifactVersions,
  artifacts,
  changeEvents,
  findings,
  graphNodes,
  semanticAnalysisAttempts,
  sourceGroupMembers,
  sourceGroups,
  sources,
  workspaces,
} from "../db/schema";
import { executeManualAnalysis } from "../lib/analysis/manual";
import type { SemanticAnalyzer } from "../lib/analysis/semantic";

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

async function seedManualCadenceRun(options: {
  relatedCodeText: string;
  includeOutsideGroup?: boolean;
}) {
  const now = new Date().toISOString();
  await db.insert(workspaces).values({
    id: "ws_manual_semantic",
    name: "Manual semantic workspace",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(sources).values([
    {
      id: "src_repo",
      workspaceId: "ws_manual_semantic",
      provider: "github",
      externalId: "repo-1",
      name: "CodeTanim/spec-graph",
      detail: "main",
      status: "connected",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "src_docs",
      workspaceId: "ws_manual_semantic",
      provider: "confluence",
      externalId: "cloud-1:space:SD",
      name: "Software development",
      detail: "codetanim / SD",
      status: "connected",
      createdAt: now,
      updatedAt: now,
    },
    ...(options.includeOutsideGroup ? [{
      id: "src_outside",
      workspaceId: "ws_manual_semantic",
      provider: "github" as const,
      externalId: "repo-outside",
      name: "CodeTanim/outside",
      detail: "main",
      status: "connected" as const,
      createdAt: now,
      updatedAt: now,
    }] : []),
  ]);
  await db.insert(sourceGroups).values({
    id: "group_manual_semantic",
    workspaceId: "ws_manual_semantic",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(sourceGroupMembers).values([
    {
      workspaceId: "ws_manual_semantic",
      groupId: "group_manual_semantic",
      sourceId: "src_repo",
      createdAt: now,
    },
    {
      workspaceId: "ws_manual_semantic",
      groupId: "group_manual_semantic",
      sourceId: "src_docs",
      createdAt: now,
    },
  ]);
  await db.insert(artifacts).values([
    {
      id: "artifact_cadence",
      sourceId: "src_repo",
      externalId: "evaluation/fixtures/repository/analysis-cadence.ts",
      kind: "code",
      path: "evaluation/fixtures/repository/analysis-cadence.ts",
      title: "analysis-cadence.ts",
      canonicalUrl: "https://github.com/CodeTanim/spec-graph/blob/abc/evaluation/fixtures/repository/analysis-cadence.ts",
      currentRevision: "abc",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "artifact_page",
      sourceId: "src_docs",
      externalId: "page-cadence",
      kind: "confluence",
      path: "SD/How SpecGraph checks connected sources",
      title: "How SpecGraph checks connected sources",
      canonicalUrl: "https://codetanim.atlassian.net/wiki/spaces/SD/pages/42",
      currentRevision: "2",
      createdAt: now,
      updatedAt: now,
    },
    ...(options.includeOutsideGroup ? [{
      id: "artifact_outside",
      sourceId: "src_outside",
      externalId: "src/outside-cadence.ts",
      kind: "code" as const,
      path: "src/outside-cadence.ts",
      title: "outside-cadence.ts",
      canonicalUrl: "https://github.com/CodeTanim/outside/blob/abc/src/outside-cadence.ts",
      currentRevision: "abc",
      createdAt: now,
      updatedAt: now,
    }] : []),
  ]);
  await db.insert(artifactVersions).values([
    {
      id: "version_cadence",
      artifactId: "artifact_cadence",
      revision: "abc",
      contentHash: "cadence-hash",
      extractedText: options.relatedCodeText,
      createdAt: now,
    },
    {
      id: "version_page_1",
      artifactId: "artifact_page",
      revision: "1",
      contentHash: "page-hash-1",
      extractedText: "Automatic analysis\nSpecGraph runs automatic impact analysis daily for connected sources.",
      createdAt: new Date(Date.now() - 1_000).toISOString(),
    },
    {
      id: "version_page_2",
      artifactId: "artifact_page",
      revision: "2",
      contentHash: "page-hash-2",
      extractedText: "Automatic analysis\nSpecGraph runs automatic impact analysis every 12 hours for connected sources.",
      createdAt: now,
    },
    ...(options.includeOutsideGroup ? [{
      id: "version_outside",
      artifactId: "artifact_outside",
      revision: "abc",
      contentHash: "outside-hash",
      extractedText: "SpecGraph runs automatic impact analysis every 12 hours for connected sources.",
      createdAt: now,
    }] : []),
  ]);
  await db.insert(graphNodes).values([
    {
      id: "node_cadence",
      artifactId: "artifact_cadence",
      stableKey: "file:evaluation/fixtures/repository/analysis-cadence.ts",
      kind: "file",
      name: "evaluation/fixtures/repository/analysis-cadence.ts",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "node_page",
      artifactId: "artifact_page",
      stableKey: "page:page-cadence",
      kind: "doc_section",
      name: "SD/How SpecGraph checks connected sources",
      createdAt: now,
      updatedAt: now,
    },
    ...(options.includeOutsideGroup ? [{
      id: "node_outside",
      artifactId: "artifact_outside",
      stableKey: "file:src/outside-cadence.ts",
      kind: "file" as const,
      name: "src/outside-cadence.ts",
      createdAt: now,
      updatedAt: now,
    }] : []),
  ]);
  await db.insert(analysisRuns).values({
    id: "run_manual_semantic",
    workspaceId: "ws_manual_semantic",
    sourceId: "src_docs",
    trigger: "manual",
    title: "Checking How SpecGraph checks connected sources",
    target: "How SpecGraph checks connected sources",
    status: "queued",
    createdAt: now,
    updatedAt: now,
  });
}

describe("manual Confluence semantic analysis", () => {
  it("flags a related implementation from natural-language cadence changes", async () => {
    await seedManualCadenceRun({
      relatedCodeText:
        "export const automaticAnalysisCadenceHours = 12;\n" +
        "export function shouldScheduleAutomaticAnalysis(elapsedHours: number) {\n" +
        "  return elapsedHours >= automaticAnalysisCadenceHours;\n" +
        "}",
      includeOutsideGroup: true,
    });
    let suppliedChangedText = "";
    const analyzer: SemanticAnalyzer = {
      name: "fixture-analyzer",
      model: "fixture/cadence",
      analyze: async (input) => {
        suppliedChangedText = input.changed.text;
        expect(input.candidates.map((candidate) => candidate.artifact.path)).toContain(
          "evaluation/fixtures/repository/analysis-cadence.ts",
        );
        expect(input.candidates.map((candidate) => candidate.artifact.path)).not.toContain(
          "src/outside-cadence.ts",
        );
        return {
          output: {
            schemaVersion: "1",
            decisions: [{
              candidateId: "node_cadence",
              impact: true,
              confidence: 0.93,
              summary: "The implementation owns the automatic analysis cadence described by this page.",
              changedExcerpt: "every 12 hours",
              candidateExcerpt: "automaticAnalysisCadenceHours = 12",
            }],
          },
          usage: {
            promptTokens: 120,
            completionTokens: 28,
            estimatedCostMicros: 30,
          },
        };
      },
    };

    await executeManualAnalysis(
      "ws_manual_semantic",
      "run_manual_semantic",
      { sourceId: "src_docs", target: "How SpecGraph checks connected sources" },
      db,
      analyzer,
    );

    expect(suppliedChangedText).toContain(
      "Before:\nSpecGraph runs automatic impact analysis daily for connected sources.",
    );
    expect(suppliedChangedText).toContain(
      "After:\nSpecGraph runs automatic impact analysis every 12 hours for connected sources.",
    );
    expect(await db.select().from(findings)).toEqual([
      expect.objectContaining({
        runId: "run_manual_semantic",
        affectedNodeId: "node_cadence",
        origin: "semantic",
        provenance: "SEMANTIC",
        confidence: 0.93,
      }),
    ]);
    expect(await db.select().from(semanticAnalysisAttempts)).toEqual([
      expect.objectContaining({
        runId: "run_manual_semantic",
        status: "succeeded",
        inputCandidateCount: 1,
        acceptedDecisionCount: 1,
        estimatedCostMicros: 30,
      }),
    ]);
    expect(await db.select().from(analysisRuns).where(
      eq(analysisRuns.id, "run_manual_semantic"),
    )).toEqual([
      expect.objectContaining({ status: "succeeded", progress: 100 }),
    ]);
    const [event] = await db.select().from(changeEvents);
    expect(event?.analysisScopeJson).toContain("every 12 hours");
    expect(event?.analysisScopeJson).toContain("daily");
  });

  it("does not call or charge the analyzer when retrieval finds no candidates", async () => {
    await seedManualCadenceRun({
      relatedCodeText: "export const paintBucketColor = 'blue';",
    });
    const analyze = vi.fn<SemanticAnalyzer["analyze"]>();

    await executeManualAnalysis(
      "ws_manual_semantic",
      "run_manual_semantic",
      { sourceId: "src_docs", target: "How SpecGraph checks connected sources" },
      db,
      { name: "fixture-analyzer", model: "fixture/no-candidates", analyze },
    );

    expect(analyze).not.toHaveBeenCalled();
    expect(await db.select().from(findings)).toHaveLength(0);
    expect(await db.select().from(semanticAnalysisAttempts)).toEqual([
      expect.objectContaining({
        status: "succeeded",
        inputCandidateCount: 0,
        promptTokens: 0,
        completionTokens: 0,
        estimatedCostMicros: 0,
      }),
    ]);
  });

  it("keeps the manual run successful when the semantic provider falls back", async () => {
    await seedManualCadenceRun({
      relatedCodeText:
        "export const automaticAnalysisCadenceHours = 12;\n" +
        "export function shouldScheduleAutomaticAnalysis() { return true; }",
    });

    await executeManualAnalysis(
      "ws_manual_semantic",
      "run_manual_semantic",
      { sourceId: "src_docs", target: "How SpecGraph checks connected sources" },
      db,
      {
        name: "fixture-analyzer",
        model: "fixture/unavailable",
        analyze: async () => {
          throw new Error("SEMANTIC_PROVIDER_UNAVAILABLE");
        },
      },
    );

    expect(await db.select().from(findings)).toHaveLength(0);
    expect(await db.select().from(semanticAnalysisAttempts)).toEqual([
      expect.objectContaining({
        status: "fallback",
        failureReason: "SEMANTIC_PROVIDER_UNAVAILABLE",
        acceptedDecisionCount: 0,
      }),
    ]);
    const [run] = await db.select().from(analysisRuns).where(
      eq(analysisRuns.id, "run_manual_semantic"),
    );
    expect(run).toMatchObject({ status: "succeeded", progress: 100 });
  });
});
