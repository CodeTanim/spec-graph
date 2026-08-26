import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SpecGraphDb } from "../db";
import * as schema from "../db/schema";
import {
  analysisRuns,
  artifactVersions,
  artifacts,
  findings,
  graphNodes,
  relationships,
  sourceGroupMembers,
  sourceGroups,
  sources,
  workspaces,
} from "../db/schema";
import { persistDeterministicFindings } from "../lib/analysis/deterministic";
import { rebuildCrossSourceRelationships } from "../lib/providers/cross-source-relationships";

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

describe("persisted entity relationships", () => {
  it("links exact code identifiers and strong peer-document entities inside one source group", async () => {
    const now = new Date().toISOString();
    await db.insert(workspaces).values({
      id: "ws_entities",
      name: "Entity workspace",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(sources).values([
      {
        id: "src_repo",
        workspaceId: "ws_entities",
        provider: "github",
        externalId: "repo-1",
        name: "acme/payments",
        detail: "main",
        status: "connected",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "src_docs",
        workspaceId: "ws_entities",
        provider: "confluence",
        externalId: "cloud:PAY",
        name: "Payments docs",
        detail: "acme / PAY",
        status: "connected",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(sourceGroups).values({
      id: "group_payments",
      workspaceId: "ws_entities",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(sourceGroupMembers).values([
      { workspaceId: "ws_entities", groupId: "group_payments", sourceId: "src_repo", createdAt: now },
      { workspaceId: "ws_entities", groupId: "group_payments", sourceId: "src_docs", createdAt: now },
    ]);
    await db.insert(artifacts).values([
      {
        id: "artifact_code",
        sourceId: "src_repo",
        externalId: "src/payments.ts",
        kind: "code",
        path: "src/payments.ts",
        title: "payments.ts",
        currentRevision: "abc",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "artifact_markdown",
        sourceId: "src_repo",
        externalId: "docs/status.md",
        kind: "markdown",
        path: "docs/status.md",
        title: "Payment status",
        currentRevision: "abc",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "artifact_confluence",
        sourceId: "src_docs",
        externalId: "page-1",
        kind: "confluence",
        path: "PAY/Architecture",
        title: "Payment architecture",
        currentRevision: "7",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(artifactVersions).values([
      {
        id: "version_code",
        artifactId: "artifact_code",
        revision: "abc",
        contentHash: "code-hash",
        extractedText: "export class PaymentService {}",
        createdAt: now,
      },
      {
        id: "version_markdown",
        artifactId: "artifact_markdown",
        revision: "abc",
        contentHash: "markdown-hash",
        extractedText: "# Status\n\nPaymentStatus describes the current lifecycle state.",
        createdAt: now,
      },
      {
        id: "version_confluence",
        artifactId: "artifact_confluence",
        revision: "7",
        contentHash: "confluence-hash",
        extractedText: "PaymentService emits a PaymentStatus after authorization.",
        createdAt: now,
      },
    ]);
    await db.insert(graphNodes).values([
      {
        id: "node_code",
        artifactId: "artifact_code",
        stableKey: "file:src/payments.ts",
        kind: "file",
        name: "src/payments.ts",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "node_payment_service",
        artifactId: "artifact_code",
        stableKey: "entity:identifier:paymentservice",
        kind: "symbol",
        name: "PaymentService",
        startLine: 1,
        endLine: 1,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "node_markdown",
        artifactId: "artifact_markdown",
        stableKey: "file:docs/status.md",
        kind: "file",
        name: "docs/status.md",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "node_confluence",
        artifactId: "artifact_confluence",
        stableKey: "page:page-1",
        kind: "doc_section",
        name: "PAY/Architecture",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(relationships).values({
      id: "relationship_contains_service",
      fromNodeId: "node_code",
      toNodeId: "node_payment_service",
      type: "contains",
      origin: "deterministic",
      provenance: "STRUCTURAL",
      analyzerVersion: "parser-v2",
      confidence: 1,
      evidence: "src/payments.ts defines PaymentService",
      evidenceStartLine: 1,
      createdAt: now,
      updatedAt: now,
    });

    await rebuildCrossSourceRelationships("ws_entities", "src_repo", db);

    const persisted = await db.select().from(relationships);
    expect(persisted).toEqual(expect.arrayContaining([
      expect.objectContaining({
        fromNodeId: "node_confluence",
        toNodeId: "node_payment_service",
        provenance: "EXACT_IDENTIFIER",
      }),
      expect.objectContaining({
        fromNodeId: "node_confluence",
        toNodeId: "node_markdown",
        provenance: "SHARED_ENTITY",
      }),
      expect.objectContaining({
        fromNodeId: "node_markdown",
        toNodeId: "node_confluence",
        provenance: "SHARED_ENTITY",
      }),
    ]));

    await db.insert(analysisRuns).values({
      id: "run_entities",
      workspaceId: "ws_entities",
      sourceId: "src_repo",
      trigger: "github",
      title: "PaymentService changed",
      target: "abc",
      status: "running",
      createdAt: now,
      updatedAt: now,
    });
    expect(await persistDeterministicFindings(
      "ws_entities",
      "run_entities",
      [{ id: "node_code", path: "src/payments.ts" }],
      db,
    )).toBe(1);
    expect(await db.select().from(findings).where(eq(findings.runId, "run_entities")))
      .toEqual([
        expect.objectContaining({
          affectedNodeId: "node_confluence",
          provenance: "EXACT_IDENTIFIER",
        }),
      ]);
  });
});
