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
  changeEvents,
  findingActions,
  findingEvidence,
  findings,
  graphNodes,
  relationships,
  sources,
} from "../db/schema";
import { persistDeterministicFindings } from "../lib/analysis/deterministic";
import { ensureWorkspaceForUser } from "../lib/server/workspace-provisioning";
import { updateFinding } from "../lib/server/specgraph-repository";

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

describe("finding review policy", () => {
  it("keeps an exact dismissed impact reviewed and opens a materially new revision", async () => {
    const context = await ensureWorkspaceForUser({
      id: "github-reviewer",
      email: "reviewer@example.com",
      displayName: "Review Engineer",
      fullName: "Review Engineer",
    }, db);
    const now = new Date().toISOString();

    await db.insert(sources).values({
      id: "src_review_policy",
      workspaceId: context.workspace.id,
      provider: "github",
      externalId: "review-policy-repo",
      name: "acme/review-policy",
      detail: "main",
      status: "connected",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(artifacts).values([
      {
        id: "artifact_changed_policy",
        sourceId: "src_review_policy",
        externalId: "src/policy.ts",
        kind: "code",
        path: "src/policy.ts",
        title: "policy.ts",
        currentRevision: "revision-1",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "artifact_affected_guide",
        sourceId: "src_review_policy",
        externalId: "docs/policy.md",
        kind: "markdown",
        path: "docs/policy.md",
        title: "Policy guide",
        currentRevision: "revision-1",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(artifactVersions).values([
      {
        id: "version_changed_policy_1",
        artifactId: "artifact_changed_policy",
        revision: "revision-1",
        contentHash: "changed-policy-hash-1",
        extractedText: "export const policyWindow = 30;",
        createdAt: now,
      },
      {
        id: "version_affected_guide_1",
        artifactId: "artifact_affected_guide",
        revision: "revision-1",
        contentHash: "affected-guide-hash-1",
        extractedText: "The policy window is 30 days.",
        createdAt: now,
      },
    ]);
    await db.insert(graphNodes).values([
      {
        id: "node_changed_policy",
        artifactId: "artifact_changed_policy",
        stableKey: "file:src/policy.ts",
        kind: "file",
        name: "src/policy.ts",
        contentHash: "changed-policy-hash-1",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "node_affected_guide",
        artifactId: "artifact_affected_guide",
        stableKey: "file:docs/policy.md",
        kind: "file",
        name: "docs/policy.md",
        contentHash: "affected-guide-hash-1",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(relationships).values({
      id: "relationship_policy_guide",
      fromNodeId: "node_changed_policy",
      toNodeId: "node_affected_guide",
      type: "documents",
      origin: "deterministic",
      provenance: "EXACT_PATH",
      analyzerVersion: "deterministic-v1",
      confidence: 1,
      evidence: "docs/policy.md references src/policy.ts",
      evidenceStartLine: 1,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(changeEvents).values([
      {
        id: "change_review_1",
        workspaceId: context.workspace.id,
        sourceId: "src_review_policy",
        trigger: "github" as const,
        title: "First policy change",
        sourceLabel: "acme/review-policy@revision-1",
        afterRevision: "revision-1",
        occurredAt: now,
        createdAt: now,
      },
      {
        id: "change_review_repeat",
        workspaceId: context.workspace.id,
        sourceId: "src_review_policy",
        trigger: "manual" as const,
        title: "Repeat policy check",
        sourceLabel: "acme/review-policy@revision-1",
        afterRevision: "revision-1",
        occurredAt: now,
        createdAt: now,
      },
      {
        id: "change_review_2",
        workspaceId: context.workspace.id,
        sourceId: "src_review_policy",
        trigger: "github" as const,
        title: "New policy change",
        sourceLabel: "acme/review-policy@revision-2",
        afterRevision: "revision-2",
        occurredAt: now,
        createdAt: now,
      },
    ]);
    await db.insert(analysisRuns).values([
      {
        id: "run_review_1",
        workspaceId: context.workspace.id,
        sourceId: "src_review_policy",
        changeEventId: "change_review_1",
        trigger: "github" as const,
        title: "First policy change",
        target: "revision-1",
        status: "running" as const,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "run_review_repeat",
        workspaceId: context.workspace.id,
        sourceId: "src_review_policy",
        changeEventId: "change_review_repeat",
        trigger: "manual" as const,
        title: "Repeat policy check",
        target: "revision-1",
        status: "running" as const,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "run_review_2",
        workspaceId: context.workspace.id,
        sourceId: "src_review_policy",
        changeEventId: "change_review_2",
        trigger: "github" as const,
        title: "New policy change",
        target: "revision-2",
        status: "running" as const,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    expect(await persistDeterministicFindings(
      context.workspace.id,
      "run_review_1",
      [{ id: "node_changed_policy", path: "src/policy.ts" }],
      db,
    )).toBe(1);
    const [firstFinding] = await db.select().from(findings);
    expect(firstFinding?.impactFingerprint).toMatch(/^impact_v1_/);

    await updateFinding(
      context.workspace.id,
      "change_review_1",
      firstFinding!.id,
      context.user.databaseId,
      "dismiss",
      db,
    );

    expect(await persistDeterministicFindings(
      context.workspace.id,
      "run_review_repeat",
      [{ id: "node_changed_policy", path: "src/policy.ts" }],
      db,
    )).toBe(0);
    expect(await db.select().from(findings)).toEqual([
      expect.objectContaining({ id: firstFinding!.id, status: "dismissed" }),
    ]);
    expect(await db.select().from(findingEvidence)).toHaveLength(1);
    expect(await db.select().from(findingActions)).toEqual([
      expect.objectContaining({ findingId: firstFinding!.id, action: "dismiss" }),
    ]);

    await db
      .update(artifacts)
      .set({ currentRevision: "revision-2", updatedAt: now })
      .where(eq(artifacts.id, "artifact_changed_policy"));
    await db.insert(artifactVersions).values({
      id: "version_changed_policy_2",
      artifactId: "artifact_changed_policy",
      revision: "revision-2",
      contentHash: "changed-policy-hash-2",
      extractedText: "export const policyWindow = 14;",
      createdAt: now,
    });

    expect(await persistDeterministicFindings(
      context.workspace.id,
      "run_review_2",
      [{ id: "node_changed_policy", path: "src/policy.ts" }],
      db,
    )).toBe(1);
    const allFindings = await db.select().from(findings);
    expect(allFindings).toHaveLength(2);
    expect(allFindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: firstFinding!.id, status: "dismissed" }),
      expect.objectContaining({ runId: "run_review_2", status: "open" }),
    ]));
    expect(new Set(allFindings.map((finding) => finding.impactFingerprint)).size).toBe(2);
    expect(await db.select().from(findingActions)).toHaveLength(1);
  });
});
