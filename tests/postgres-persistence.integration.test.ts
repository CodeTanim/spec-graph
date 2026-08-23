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
  findingEvidence,
  findings,
  graphNodes,
  relationships,
  sources,
} from "../db/schema";
import { persistDeterministicFindings } from "../lib/analysis/deterministic";
import {
  beginRunAttempt,
  completeRunAttempt,
  failRunAttempt,
} from "../lib/analysis/run-lifecycle";
import { associateSources } from "../lib/providers/source-associations";
import { ensureWorkspaceForUser } from "../lib/server/workspace-provisioning";
import {
  createManualRun,
  listChanges,
  listRuns,
  updateChange,
} from "../lib/server/specgraph-repository";

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

async function workspace() {
  return ensureWorkspaceForUser(
    {
      id: "github-user-42",
      email: "engineer@example.com",
      displayName: "Example Engineer",
      fullName: "Example Engineer",
    },
    db,
  );
}

describe("Neon-compatible Postgres persistence", () => {
  it("persists one workspace, deduplicates source pairs, and retries runs safely", async () => {
    const first = await workspace();
    const second = await workspace();
    expect(second.workspace.id).toBe(first.workspace.id);

    const now = new Date().toISOString();
    await db.insert(sources).values([
      {
        id: "src_repo",
        workspaceId: first.workspace.id,
        provider: "github",
        externalId: "501",
        name: "acme/platform-api",
        detail: "main",
        defaultBranch: "main",
        status: "connected",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "src_docs",
        workspaceId: first.workspace.id,
        provider: "confluence",
        externalId: "cloud-1:space:ENG",
        name: "Engineering",
        detail: "Acme / ENG",
        status: "connected",
        createdAt: now,
        updatedAt: now,
      },
    ]);

    expect(
      await associateSources(
        first.workspace.id,
        "src_repo",
        "src_docs",
        db,
      ),
    ).toMatchObject({ alreadyTracked: false });
    expect(
      await associateSources(
        first.workspace.id,
        "src_repo",
        "src_docs",
        db,
      ),
    ).toMatchObject({ alreadyTracked: true });

    const created = await createManualRun(
      first.workspace.id,
      first.user.databaseId,
      { sourceId: "src_repo", target: "#7" },
      db,
    );
    const attemptOne = await beginRunAttempt(
      created.run.id,
      "github_pull_request",
      db,
    );
    expect(attemptOne).toBeTruthy();
    await failRunAttempt(
      created.run.id,
      attemptOne,
      new Error("temporary GitHub failure"),
      "TEST_FAILURE",
      "temporary failure",
      db,
    );
    const attemptTwo = await beginRunAttempt(
      created.run.id,
      "github_pull_request",
      db,
    );
    expect(attemptTwo).toBeTruthy();
    await completeRunAttempt(created.run.id, attemptTwo!, db);

    const runs = await listRuns(first.workspace.id, db);
    expect(runs.items[0]).toMatchObject({
      id: created.run.id,
      status: "succeeded",
    });
  });

  it("persists evidence links and review actions", async () => {
    const context = await workspace();
    const now = new Date().toISOString();
    await db.insert(sources).values({
      id: "src_repo",
      workspaceId: context.workspace.id,
      provider: "github",
      externalId: "501",
      name: "acme/platform-api",
      detail: "main",
      status: "connected",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(artifacts).values({
      id: "art_doc",
      sourceId: "src_repo",
      externalId: "docs/refunds.md",
      kind: "markdown",
      path: "docs/refunds.md",
      title: "Refund documentation",
      canonicalUrl:
        "https://github.com/acme/platform-api/blob/abc123/docs/refunds.md",
      currentRevision: "abc123",
      contentHash: "hash",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(artifactVersions).values({
      id: "ver_doc",
      artifactId: "art_doc",
      revision: "abc123",
      contentHash: "hash",
      extractedText: "Refunds are available for 30 days.",
      createdAt: now,
    });
    await db.insert(graphNodes).values({
      id: "node_doc",
      artifactId: "art_doc",
      stableKey: "file:docs/refunds.md",
      kind: "doc_section",
      name: "Refund documentation",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(changeEvents).values({
      id: "chg_1",
      workspaceId: context.workspace.id,
      sourceId: "src_repo",
      trigger: "github",
      title: "Refund window changed",
      summary: "The implementation now allows 60 days.",
      evidenceSummary: "A deterministic documentation link connected the files.",
      sourceLabel: "acme/platform-api@abc123",
      sourceUrl: "https://github.com/acme/platform-api/commit/abc123",
      occurredAt: now,
      createdAt: now,
    });
    await db.insert(analysisRuns).values({
      id: "run_1",
      workspaceId: context.workspace.id,
      sourceId: "src_repo",
      changeEventId: "chg_1",
      trigger: "github",
      title: "Refund window changed",
      target: "abc123",
      status: "succeeded",
      progress: 100,
      attempts: 1,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(findings).values({
      id: "finding_1",
      runId: "run_1",
      affectedNodeId: "node_doc",
      title: "Refund documentation may be stale",
      summary: "The documentation still says 30 days.",
      deduplicationKey: "refund-doc",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(findingEvidence).values({
      id: "evidence_1",
      findingId: "finding_1",
      artifactVersionId: "ver_doc",
      location: "docs/refunds.md:1",
      excerpt: "Refunds are available for 30 days.",
      sourceUrl:
        "https://github.com/acme/platform-api/blob/abc123/docs/refunds.md#L1",
      createdAt: now,
    });

    const open = await listChanges(context.workspace.id, "open", db);
    expect(open.items[0].artifacts[0].externalUrl).toContain("github.com");
    await updateChange(
      context.workspace.id,
      "chg_1",
      context.user.databaseId,
      "dismiss",
      db,
    );
    expect((await listChanges(context.workspace.id, "open", db)).items).toHaveLength(0);
    expect((await listChanges(context.workspace.id, "all", db)).items[0].status).toBe(
      "checked",
    );
    const [persistedFinding] = await db
      .select({ status: findings.status })
      .from(findings)
      .where(eq(findings.id, "finding_1"));
    expect(persistedFinding.status).toBe("dismissed");
  });

  it("persists only cross-domain impacts and supports documentation-to-documentation", async () => {
    const context = await workspace();
    const now = new Date().toISOString();

    await db.insert(sources).values({
      id: "src_policy",
      workspaceId: context.workspace.id,
      provider: "github",
      externalId: "policy-repo",
      name: "acme/policy",
      detail: "main",
      status: "connected",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(artifacts).values([
      {
        id: "art_changed_code",
        sourceId: "src_policy",
        externalId: "src/policy.ts",
        kind: "code",
        path: "src/policy.ts",
        title: "policy.ts",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "art_code_neighbor",
        sourceId: "src_policy",
        externalId: "src/types.ts",
        kind: "code",
        path: "src/types.ts",
        title: "types.ts",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "art_primary_doc",
        sourceId: "src_policy",
        externalId: "docs/policy.md",
        kind: "markdown",
        path: "docs/policy.md",
        title: "Policy guide",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "art_secondary_doc",
        sourceId: "src_policy",
        externalId: "docs/customer-policy.md",
        kind: "confluence",
        path: "docs/customer-policy.md",
        title: "Customer policy",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(graphNodes).values([
      {
        id: "node_changed_code",
        artifactId: "art_changed_code",
        stableKey: "file:src/policy.ts",
        kind: "file",
        name: "policy.ts",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "node_code_neighbor",
        artifactId: "art_code_neighbor",
        stableKey: "file:src/types.ts",
        kind: "file",
        name: "types.ts",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "node_primary_doc",
        artifactId: "art_primary_doc",
        stableKey: "file:docs/policy.md",
        kind: "doc_section",
        name: "Policy guide",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "node_secondary_doc",
        artifactId: "art_secondary_doc",
        stableKey: "page:customer-policy",
        kind: "doc_section",
        name: "Customer policy",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(relationships).values([
      {
        id: "rel_code_import",
        fromNodeId: "node_changed_code",
        toNodeId: "node_code_neighbor",
        type: "imports",
        origin: "deterministic",
        confidence: 1,
        evidence: "policy.ts imports types.ts",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "rel_doc_code",
        fromNodeId: "node_primary_doc",
        toNodeId: "node_changed_code",
        type: "documents",
        origin: "deterministic",
        confidence: 1,
        evidence: "The policy guide documents policy.ts",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "rel_doc_doc",
        fromNodeId: "node_primary_doc",
        toNodeId: "node_secondary_doc",
        type: "documents",
        origin: "deterministic",
        confidence: 1,
        evidence: "The customer page mirrors the policy guide",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(analysisRuns).values([
      {
        id: "run_code_policy",
        workspaceId: context.workspace.id,
        sourceId: "src_policy",
        trigger: "github",
        title: "Code policy changed",
        target: "main",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "run_doc_policy",
        workspaceId: context.workspace.id,
        sourceId: "src_policy",
        trigger: "github",
        title: "Documentation policy changed",
        target: "main",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "run_mixed_policy",
        workspaceId: context.workspace.id,
        sourceId: "src_policy",
        trigger: "github",
        title: "Code and documentation changed together",
        target: "main",
        createdAt: now,
        updatedAt: now,
      },
    ]);

    expect(
      await persistDeterministicFindings(
        context.workspace.id,
        "run_code_policy",
        [{ id: "node_changed_code", path: "src/policy.ts" }],
        db,
      ),
    ).toBe(1);
    expect(
      await db
        .select({ affectedNodeId: findings.affectedNodeId })
        .from(findings)
        .where(eq(findings.runId, "run_code_policy")),
    ).toEqual([{ affectedNodeId: "node_primary_doc" }]);

    expect(
      await persistDeterministicFindings(
        context.workspace.id,
        "run_doc_policy",
        [{ id: "node_primary_doc", path: "docs/policy.md" }],
        db,
      ),
    ).toBe(2);
    expect(
      new Set(
        (
          await db
            .select({ affectedNodeId: findings.affectedNodeId })
            .from(findings)
            .where(eq(findings.runId, "run_doc_policy"))
        ).map((finding) => finding.affectedNodeId),
      ),
    ).toEqual(new Set(["node_changed_code", "node_secondary_doc"]));

    expect(
      await persistDeterministicFindings(
        context.workspace.id,
        "run_mixed_policy",
        [
          { id: "node_changed_code", path: "src/policy.ts" },
          { id: "node_primary_doc", path: "docs/policy.md" },
        ],
        db,
      ),
    ).toBe(1);
    expect(
      await db
        .select({ affectedNodeId: findings.affectedNodeId })
        .from(findings)
        .where(eq(findings.runId, "run_mixed_policy")),
    ).toEqual([{ affectedNodeId: "node_secondary_doc" }]);
  });
});
