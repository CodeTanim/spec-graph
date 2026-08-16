import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import { Miniflare } from "miniflare";

let miniflare;
let database;

before(async () => {
  const workerPath = fileURLToPath(
    new URL("../dist/server/index.js", import.meta.url),
  );
  miniflare = new Miniflare({
    modules: true,
    scriptPath: workerPath,
    modulesRules: [{ type: "ESModule", include: ["**/*.js"] }],
    compatibilityDate: "2026-05-22",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "specgraph-api-test" },
    serviceBindings: {
      ASSETS: async () => new Response("Not found", { status: 404 }),
    },
  });
  database = await miniflare.getD1Database("DB");

  const migrationUrl = new URL("../drizzle/0000_good_sersi.sql", import.meta.url);
  const migration = await readFile(migrationUrl, "utf8");
  const statements = migration
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);

  for (const statement of statements) {
    await database.prepare(statement).run();
  }
});

after(async () => {
  await miniflare?.dispose();
});

function appFetch(path, init = {}, providerUserId = "test-user-1") {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  headers.set("oai-authenticated-user-id", providerUserId);
  headers.set(
    "oai-authenticated-user-email",
    `${providerUserId}@specgraph.local`,
  );

  return miniflare.dispatchFetch(`http://localhost${path}`, {
    ...init,
    headers,
  });
}

async function json(response) {
  const payload = await response.json();
  assert.equal(response.headers.get("content-type")?.includes("application/json"), true);
  return payload;
}

async function workspaceRecord() {
  return database
    .prepare(
      `SELECT wm.workspace_id AS workspaceId, wm.user_id AS userId
       FROM workspace_members wm
       JOIN users u ON u.id = wm.user_id
       WHERE u.provider_user_id = ?`,
    )
    .bind("test-user-1")
    .first();
}

test("authenticated API requests create one durable personal workspace", async () => {
  const first = await appFetch("/api/sources");
  assert.equal(first.status, 200);
  assert.deepEqual(await json(first), { items: [] });

  const second = await appFetch("/api/sources");
  assert.equal(second.status, 200);

  const users = await database.prepare("SELECT COUNT(*) AS count FROM users").first();
  const workspaces = await database.prepare("SELECT COUNT(*) AS count FROM workspaces").first();
  const memberships = await database
    .prepare("SELECT COUNT(*) AS count FROM workspace_members")
    .first();

  assert.equal(users.count, 1);
  assert.equal(workspaces.count, 1);
  assert.equal(memberships.count, 1);
});

test("changes, evidence, review actions, and manual runs persist through the APIs", async () => {
  await appFetch("/api/sources");
  const context = await workspaceRecord();
  assert.ok(context);
  const now = "2026-08-15T16:00:00.000Z";

  await database.batch([
    database
      .prepare(
        `INSERT INTO sources
         (id, workspace_id, provider, external_id, name, detail, default_branch, status, last_synced_at, created_at, updated_at)
         VALUES (?, ?, 'github', 'acme/platform-api', 'acme/platform-api', 'main', 'main', 'connected', ?, ?, ?)`,
      )
      .bind("source-1", context.workspaceId, now, now, now),
    database
      .prepare(
        `INSERT INTO artifacts
         (id, source_id, external_id, kind, path, title, canonical_url, current_revision, content_hash, created_at, updated_at)
         VALUES (?, ?, ?, 'markdown', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "artifact-1",
        "source-1",
        "docs/refunds.md",
        "docs/refunds.md",
        "Refund guide",
        "https://github.com/acme/platform-api/blob/abc123/docs/refunds.md",
        "abc123",
        "hash-1",
        now,
        now,
      ),
  ]);

  await database.batch([
    database
      .prepare(
        `INSERT INTO artifact_versions
         (id, artifact_id, revision, content_hash, extracted_text, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "version-1",
        "artifact-1",
        "abc123",
        "hash-1",
        "Refunds are available within 30 days.",
        now,
      ),
    database
      .prepare(
        `INSERT INTO graph_nodes
         (id, artifact_id, stable_key, kind, name, start_line, end_line, content_hash, created_at, updated_at)
         VALUES (?, ?, ?, 'doc_section', ?, 4, 8, ?, ?, ?)`,
      )
      .bind(
        "node-1",
        "artifact-1",
        "heading:eligibility",
        "Eligibility",
        "node-hash-1",
        now,
        now,
      ),
    database
      .prepare(
        `INSERT INTO change_events
         (id, workspace_id, source_id, trigger, title, summary, evidence_summary, source_label, source_url, after_revision, occurred_at, created_at)
         VALUES (?, ?, ?, 'github', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "change-1",
        context.workspaceId,
        "source-1",
        "Refund validation window changed",
        "The refund window changed from 30 to 60 days.",
        "The changed policy and guide describe the same rule.",
        "src/refunds/policy.ts",
        "https://github.com/acme/platform-api/blob/abc123/src/refunds/policy.ts",
        "abc123",
        now,
        now,
      ),
  ]);

  await database
    .prepare(
      `INSERT INTO analysis_runs
       (id, workspace_id, source_id, change_event_id, requested_by_user_id, trigger, title, target, status, progress, attempts, completed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'github', ?, ?, 'succeeded', 100, 1, ?, ?, ?)`,
    )
    .bind(
      "run-1",
      context.workspaceId,
      "source-1",
      "change-1",
      context.userId,
      "Refund validation window changed",
      "abc123",
      now,
      now,
      now,
    )
    .run();

  await database.batch([
    database
      .prepare(
        `INSERT INTO findings
         (id, run_id, affected_node_id, title, summary, confidence, origin, status, deduplication_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, 'deterministic', 'open', ?, ?, ?)`,
      )
      .bind(
        "finding-1",
        "run-1",
        "node-1",
        "Refund guide",
        "The guide still states the previous window.",
        "refund-guide-window",
        now,
        now,
      ),
    database
      .prepare(
        `INSERT INTO finding_evidence
         (id, finding_id, artifact_version_id, location, start_line, end_line, excerpt, source_url, type, created_at)
         VALUES (?, ?, ?, ?, 4, 4, ?, ?, 'source', ?)`,
      )
      .bind(
        "evidence-1",
        "finding-1",
        "version-1",
        "docs/refunds.md / Eligibility",
        "Refunds are available within 30 days.",
        "https://github.com/acme/platform-api/blob/abc123/docs/refunds.md#L4",
        now,
      ),
  ]);

  const openResponse = await appFetch("/api/changes?status=open");
  assert.equal(openResponse.status, 200);
  const open = await json(openResponse);
  assert.equal(open.counts.open, 1);
  assert.equal(open.items[0].title, "Refund validation window changed");
  assert.equal(open.items[0].artifacts[0].externalUrl.endsWith("#L4"), true);

  const crossWorkspaceResponse = await appFetch(
    "/api/changes/change-1",
    {},
    "test-user-2",
  );
  assert.equal(crossWorkspaceResponse.status, 404);

  const resolveResponse = await appFetch("/api/changes/change-1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "resolve" }),
  });
  assert.equal(resolveResponse.status, 200);
  const resolved = await json(resolveResponse);
  assert.equal(resolved.item.status, "checked");

  const openAfterResolve = await json(await appFetch("/api/changes?status=open"));
  assert.equal(openAfterResolve.items.length, 0);
  const actions = await database
    .prepare("SELECT COUNT(*) AS count FROM finding_actions WHERE finding_id = ?")
    .bind("finding-1")
    .first();
  assert.equal(actions.count, 1);

  const runResponse = await appFetch("/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceId: "source-1", target: "main" }),
  });
  assert.equal(runResponse.status, 202);
  const createdRun = await json(runResponse);
  assert.equal(createdRun.run.status, "queued");

  const runsResponse = await json(await appFetch("/api/runs"));
  assert.equal(runsResponse.items.some((run) => run.id === createdRun.run.id), true);
});
