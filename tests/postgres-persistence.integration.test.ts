import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SpecGraphDb } from "../db";
import * as schema from "../db/schema";
import {
  analysisRuns,
  artifactAnalysisCursors,
  artifactVersions,
  artifacts,
  changeEvents,
  findingEvidence,
  findings,
  githubInstallations,
  graphNodes,
  relationships,
  sources,
  webhookDeliveries,
} from "../db/schema";
import { persistDeterministicFindings } from "../lib/analysis/deterministic";
import { analyzePendingConfluenceChanges } from "../lib/confluence/scheduled";
import { acceptGitHubWebhook } from "../lib/github/webhook";
import { resolveGitHubChangedNodes } from "../lib/openapi/changes";
import {
  beginRunAttempt,
  completeRunAttempt,
  failRunAttempt,
} from "../lib/analysis/run-lifecycle";
import { associateSources } from "../lib/providers/source-associations";
import { rebuildCrossSourceRelationships } from "../lib/providers/cross-source-relationships";
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
  it("queues a signed-provider GitHub change until the cadence processes it", async () => {
    const context = await workspace();
    const now = new Date().toISOString();
    await db.insert(githubInstallations).values({
      id: "installation-1",
      workspaceId: context.workspace.id,
      externalInstallationId: "101",
      accountLogin: "acme",
      accountType: "Organization",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(sources).values({
      id: "src_repo",
      workspaceId: context.workspace.id,
      githubInstallationId: "installation-1",
      provider: "github",
      externalId: "501",
      name: "acme/platform-api",
      detail: "main",
      defaultBranch: "main",
      status: "connected",
      createdAt: now,
      updatedAt: now,
    });
    const body = new TextEncoder().encode(JSON.stringify({
      ref: "refs/heads/main",
      before: "abc",
      after: "def",
      compare: "https://github.com/acme/platform-api/compare/abc...def",
      installation: { id: 101 },
      repository: { full_name: "acme/platform-api" },
      sender: { login: "octocat" },
      commits: [{ added: [], modified: ["app/page.tsx"], removed: [] }],
      head_commit: {
        message: "Update the product page",
        timestamp: now,
        added: [],
        modified: ["app/page.tsx"],
        removed: [],
      },
    }));

    const first = await acceptGitHubWebhook("delivery-1", "push", body, db);
    const duplicate = await acceptGitHubWebhook("delivery-1", "push", body, db);
    const runs = await db.select().from(analysisRuns);
    const deliveries = await db.select().from(webhookDeliveries);

    expect(first.body).toMatchObject({ status: "received", duplicate: false });
    expect(duplicate.body).toMatchObject({ status: "received", duplicate: true });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "queued", trigger: "github" });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      status: "received",
      analysisRunId: runs[0].id,
    });
  });

  it("turns each new Confluence page version into one scheduled run", async () => {
    const context = await workspace();
    const now = new Date().toISOString();
    await db.insert(sources).values([
      {
        id: "src_repo",
        workspaceId: context.workspace.id,
        provider: "github",
        externalId: "501",
        name: "acme/platform-api",
        detail: "main",
        status: "connected",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "src_docs",
        workspaceId: context.workspace.id,
        provider: "confluence",
        externalId: "cloud-1:space:ENG",
        name: "Engineering",
        detail: "Acme / ENG",
        status: "connected",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(artifacts).values([
      {
        id: "art_code",
        sourceId: "src_repo",
        externalId: "app/page.tsx",
        kind: "code",
        path: "app/page.tsx",
        title: "page.tsx",
        canonicalUrl: "https://github.com/acme/platform-api/blob/abc/app/page.tsx",
        currentRevision: "abc",
        contentHash: "code-hash",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "art_page",
        sourceId: "src_docs",
        externalId: "page-1",
        kind: "confluence",
        path: "ENG/Architecture",
        title: "Architecture",
        canonicalUrl: "https://acme.atlassian.net/wiki/spaces/ENG/pages/1/Architecture",
        currentRevision: "2",
        contentHash: "page-v2",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(artifactVersions).values({
      id: "ver_page_2",
      artifactId: "art_page",
      revision: "2",
      contentHash: "page-v2",
      extractedText: "Related code: app/page.tsx",
      createdAt: now,
    });
    await db.insert(graphNodes).values([
      {
        id: "node_code",
        artifactId: "art_code",
        stableKey: "file:app/page.tsx",
        kind: "file",
        name: "page.tsx",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "node_page",
        artifactId: "art_page",
        stableKey: "page:page-1",
        kind: "doc_section",
        name: "Architecture",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(relationships).values({
      id: "rel_page_code",
      fromNodeId: "node_page",
      toNodeId: "node_code",
      type: "documents",
      origin: "deterministic",
      evidence: "Related code: app/page.tsx",
      evidenceStartLine: 1,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(artifactAnalysisCursors).values({
      artifactId: "art_page",
      revision: "1",
      createdAt: now,
      updatedAt: now,
    });

    const first = await analyzePendingConfluenceChanges(
      context.workspace.id,
      "src_docs",
      db,
    );
    const second = await analyzePendingConfluenceChanges(
      context.workspace.id,
      "src_docs",
      db,
    );

    expect(first).toMatchObject({ changedPages: 1 });
    expect(first.runId).toMatch(/^run_cnf_/);
    expect(second).toEqual({ changedPages: 0, runId: null });
    expect(await db.select().from(analysisRuns)).toHaveLength(1);
    expect(await db.select().from(changeEvents)).toHaveLength(1);
    expect(await db.select().from(findings)).toHaveLength(1);
    expect(await db.select().from(findingEvidence)).toHaveLength(1);
    expect(await db.select().from(artifactAnalysisCursors)).toEqual([
      expect.objectContaining({ artifactId: "art_page", revision: "2" }),
    ]);
  });

  it("uses structured OpenAPI diffs to flag only documentation for the changed contract", async () => {
    const context = await workspace();
    const now = new Date().toISOString();
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
  /orders:
    get:
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
    await db.insert(sources).values([
      {
        id: "src_openapi",
        workspaceId: context.workspace.id,
        provider: "github",
        externalId: "contract-repo",
        name: "acme/contracts",
        detail: "main",
        status: "connected",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "src_openapi_docs",
        workspaceId: context.workspace.id,
        provider: "confluence",
        externalId: "cloud-1:space:API",
        name: "API documentation",
        detail: "Acme / API",
        status: "connected",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(artifacts).values([
      {
        id: "art_contract",
        sourceId: "src_openapi",
        externalId: "api/openapi.yaml",
        kind: "openapi",
        path: "api/openapi.yaml",
        title: "openapi.yaml",
        canonicalUrl: "https://github.com/acme/contracts/blob/after/api/openapi.yaml",
        currentRevision: "after",
        contentHash: "after-hash",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "art_users_guide",
        sourceId: "src_openapi_docs",
        externalId: "users-guide",
        kind: "confluence",
        path: "API/Users",
        title: "Users API guide",
        canonicalUrl: "https://acme.atlassian.net/wiki/spaces/API/pages/1/Users",
        currentRevision: "1",
        contentHash: "users-hash",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "art_orders_guide",
        sourceId: "src_openapi_docs",
        externalId: "orders-guide",
        kind: "confluence",
        path: "API/Orders",
        title: "Orders API guide",
        canonicalUrl: "https://acme.atlassian.net/wiki/spaces/API/pages/2/Orders",
        currentRevision: "1",
        contentHash: "orders-hash",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(artifactVersions).values([
      {
        id: "ver_contract_before",
        artifactId: "art_contract",
        revision: "before",
        contentHash: "before-hash",
        extractedText: before,
        createdAt: new Date(Date.now() - 1_000).toISOString(),
      },
      {
        id: "ver_contract_after",
        artifactId: "art_contract",
        revision: "after",
        contentHash: "after-hash",
        extractedText: after,
        createdAt: now,
      },
      {
        id: "ver_users_guide",
        artifactId: "art_users_guide",
        revision: "1",
        contentHash: "users-hash",
        extractedText: "Create users with POST /users and provide a name.",
        createdAt: now,
      },
      {
        id: "ver_orders_guide",
        artifactId: "art_orders_guide",
        revision: "1",
        contentHash: "orders-hash",
        extractedText: "List orders with GET /orders.",
        createdAt: now,
      },
    ]);
    await db.insert(graphNodes).values([
      {
        id: "node_contract",
        artifactId: "art_contract",
        stableKey: "file:api/openapi.yaml",
        kind: "schema",
        name: "api/openapi.yaml",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "node_users_guide",
        artifactId: "art_users_guide",
        stableKey: "page:users-guide",
        kind: "doc_section",
        name: "Users API guide",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "node_orders_guide",
        artifactId: "art_orders_guide",
        stableKey: "page:orders-guide",
        kind: "doc_section",
        name: "Orders API guide",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await associateSources(
      context.workspace.id,
      "src_openapi",
      "src_openapi_docs",
      db,
    );
    await rebuildCrossSourceRelationships(
      context.workspace.id,
      "src_openapi",
      db,
    );
    expect(
      (await db.select({ type: relationships.type }).from(relationships)).map(
        (relationship) => relationship.type,
      ),
    ).toEqual(expect.arrayContaining([
      "covers_openapi:operation:POST:/users",
      "covers_openapi:operation:GET:/orders",
    ]));
    await db.insert(analysisRuns).values({
      id: "run_openapi",
      workspaceId: context.workspace.id,
      sourceId: "src_openapi",
      trigger: "github",
      title: "Require user email",
      target: "main",
      createdAt: now,
      updatedAt: now,
    });

    const resolved = await resolveGitHubChangedNodes(
      "src_openapi",
      ["api/openapi.yaml"],
      "before",
      "after",
      db,
    );
    expect(resolved.changedNodes).toEqual([
      expect.objectContaining({
        id: "node_contract",
        changeSummary: "User: email is now required.",
        changeKeys: expect.arrayContaining(["path:/users"]),
      }),
    ]);
    expect(
      await persistDeterministicFindings(
        context.workspace.id,
        "run_openapi",
        resolved.changedNodes,
        db,
      ),
    ).toBe(1);
    expect(await db.select().from(findings)).toEqual([
      expect.objectContaining({
        affectedNodeId: "node_users_guide",
        summary: expect.stringContaining("User: email is now required."),
      }),
    ]);
  });

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
      changedArtifactsJson: JSON.stringify([
        {
          id: "src/refunds/policy.ts",
          name: "policy.ts",
          kind: "Code",
          location: "src/refunds/policy.ts",
          externalUrl: "https://github.com/acme/platform-api/commit/abc123",
        },
      ]),
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
    expect(open.items[0].changedArtifacts).toEqual([
      expect.objectContaining({ location: "src/refunds/policy.ts", kind: "Code" }),
    ]);
    expect(open.items[0].artifacts[0].externalUrl).toContain("github.com");
    expect(open.items[0].artifacts[0].evidenceLocation).toBe("docs/refunds.md:1");
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
