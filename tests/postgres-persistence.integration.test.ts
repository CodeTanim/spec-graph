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
  sources,
} from "../db/schema";
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
});
