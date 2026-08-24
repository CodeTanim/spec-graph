import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import { Miniflare } from "miniflare";

let miniflare;
let database;
let githubBlobRequests = 0;
const githubWebhookSecret = "test-webhook-secret";

const githubBlobs = {
  "sha-policy": "export const REFUND_WINDOW_DAYS = 60;\n",
  "sha-test":
    'import { REFUND_WINDOW_DAYS } from "../src/refunds/policy";\nexpect(REFUND_WINDOW_DAYS).toBe(30);\n',
  "sha-doc": "# Refunds\n\n[Policy implementation](../src/refunds/policy.ts)\n",
  "sha-openapi": "openapi: 3.1.0\npaths:\n  /refunds:\n    post:\n",
};

function githubResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function fakeGitHub(request) {
  const url = new URL(request.url);
  if (url.hostname === "auth.atlassian.com" && url.pathname === "/oauth/token") {
    return githubResponse({
      access_token: "atlassian-access-token",
      refresh_token: "atlassian-refresh-token",
      expires_in: 3600,
      scope: "read:space:confluence read:page:confluence offline_access",
    });
  }
  if (url.hostname === "api.atlassian.com" && url.pathname === "/oauth/token/accessible-resources") {
    return githubResponse([{ id: "cloud-1", name: "Acme", url: "https://acme.atlassian.net", scopes: ["read:space:confluence", "read:page:confluence"] }]);
  }
  if (url.hostname === "api.atlassian.com" && url.pathname === "/ex/confluence/cloud-1/wiki/api/v2/spaces") {
    return githubResponse({ results: [{ id: "space-1", key: "ENG", name: "Engineering" }] });
  }
  if (url.hostname === "api.atlassian.com" && url.pathname === "/ex/confluence/cloud-1/wiki/api/v2/spaces/space-1/pages") {
    return githubResponse({
      results: [
        {
          id: "page-1",
          title: "Refund policy",
          spaceId: "space-1",
          body: { storage: { value: "<p>See src/refunds/policy.ts and docs/refunds.md for the 60 day window.</p>" } },
          version: { number: 3 },
          // Atlassian may omit the tenant's /wiki context path from webui links.
          _links: { webui: "/spaces/ENG/pages/1/Refund+policy" },
        },
        {
          id: "page-2",
          title: "Release notes",
          spaceId: "space-1",
          body: { storage: { value: "<p>Current release notes.</p>" } },
          version: { number: 2 },
          _links: { webui: "/spaces/ENG/pages/2/Release+notes" },
        },
      ],
    });
  }
  if (url.hostname === "github.com" && url.pathname === "/login/oauth/access_token") {
    return githubResponse({ access_token: "ghu_test_user_token", token_type: "bearer" });
  }
  if (url.hostname !== "api.github.com") {
    return githubResponse({ message: `Unexpected host ${url.hostname}` }, 500);
  }
  if (url.pathname === "/user/installations") {
    return githubResponse({
      installations: [
        {
          id: 101,
          account: { login: "acme", type: "Organization" },
          suspended_at: null,
        },
      ],
    });
  }
  if (url.pathname === "/user/installations/101/repositories") {
    return githubResponse({
      repositories: [
        {
          id: 501,
          full_name: "acme/platform-api",
          name: "platform-api",
          private: true,
          default_branch: "main",
          owner: { login: "acme" },
        },
      ],
    });
  }
  if (url.pathname === "/app/installations/101/access_tokens") {
    return githubResponse({ token: "ghs_test_installation_token" });
  }
  if (url.pathname === "/repos/acme/platform-api/branches/main") {
    return githubResponse({ commit: { sha: "base123" } });
  }
  if (url.pathname === "/repos/acme/platform-api/git/trees/base123") {
    return githubResponse({
      truncated: false,
      tree: [
        { path: "src/refunds/policy.ts", mode: "100644", type: "blob", sha: "sha-policy", size: 40 },
        { path: "tests/refunds.test.ts", mode: "100644", type: "blob", sha: "sha-test", size: 110 },
        { path: "docs/refunds.md", mode: "100644", type: "blob", sha: "sha-doc", size: 70 },
        { path: "api/openapi.yaml", mode: "100644", type: "blob", sha: "sha-openapi", size: 60 },
        { path: "public/logo.png", mode: "100644", type: "blob", sha: "sha-logo", size: 100 },
      ],
    });
  }
  const blobMatch = url.pathname.match(/^\/repos\/acme\/platform-api\/git\/blobs\/(.+)$/);
  if (blobMatch && githubBlobs[blobMatch[1]]) {
    githubBlobRequests += 1;
    return githubResponse({
      encoding: "base64",
      content: Buffer.from(githubBlobs[blobMatch[1]], "utf8").toString("base64"),
    });
  }
  if (url.pathname === "/repos/acme/platform-api/pulls/7") {
    return githubResponse({
      number: 7,
      title: "Extend the refund window",
      html_url: "https://github.com/acme/platform-api/pull/7",
      user: { login: "octocat" },
      base: { sha: "base123" },
      head: { sha: "head789" },
      changed_files: 1,
    });
  }
  if (url.pathname === "/repos/acme/platform-api/pulls/7/files") {
    return githubResponse([
      {
        filename: "src/refunds/policy.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        changes: 2,
        blob_url:
          "https://github.com/acme/platform-api/blob/head789/src/refunds/policy.ts",
      },
    ]);
  }
  return githubResponse({ message: `Unexpected GitHub route ${url.pathname}` }, 500);
}

before(async () => {
  const workerPath = fileURLToPath(
    new URL("../dist/server/index.js", import.meta.url),
  );
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  miniflare = new Miniflare({
    modules: true,
    scriptPath: workerPath,
    modulesRules: [{ type: "ESModule", include: ["**/*.js"] }],
    compatibilityDate: "2026-05-22",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "specgraph-api-test-package5" },
    bindings: {
      GITHUB_APP_SLUG: "specgraph-test",
      GITHUB_CLIENT_ID: "Iv1.test",
      GITHUB_CLIENT_SECRET: "test-client-secret",
      GITHUB_APP_ID: "12345",
      GITHUB_PRIVATE_KEY: privateKey,
      GITHUB_WEBHOOK_SECRET: githubWebhookSecret,
      CONFLUENCE_CLIENT_ID: "confluence-client-id",
      CONFLUENCE_CLIENT_SECRET: "confluence-client-secret",
      CONNECTOR_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    },
    outboundService: fakeGitHub,
    serviceBindings: {
      ASSETS: async () => new Response("Not found", { status: 404 }),
    },
  });
  database = await miniflare.getD1Database("DB");

  const migrationsUrl = new URL("../drizzle/", import.meta.url);
  const migrationNames = (await readdir(migrationsUrl))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const migrationName of migrationNames) {
    const migration = await readFile(new URL(migrationName, migrationsUrl), "utf8");
    const statements = migration
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter(Boolean);
    for (const statement of statements) {
      await database.prepare(statement).run();
    }
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

async function waitForRun(runId) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await appFetch(`/api/runs/${encodeURIComponent(runId)}`);
    assert.equal(response.status, 200);
    const payload = await json(response);
    if (payload.run.status === "succeeded" || payload.run.status === "failed") {
      return payload.run;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Analysis run ${runId} did not finish.`);
}

function githubWebhook(eventType, deliveryId, payload, signature = null) {
  const body = JSON.stringify(payload);
  const digest = signature || `sha256=${createHmac("sha256", githubWebhookSecret).update(body).digest("hex")}`;
  return miniflare.dispatchFetch("http://localhost/api/github/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-delivery": deliveryId,
      "x-github-event": eventType,
      "x-hub-signature-256": digest,
    },
    body,
  });
}

async function waitForDelivery(deliveryId) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const delivery = await database
      .prepare(
        `SELECT status, error_message AS errorMessage
         FROM webhook_deliveries
         WHERE provider = 'github' AND provider_delivery_id = ?`,
      )
      .bind(deliveryId)
      .first();
    if (delivery && delivery.status !== "received") return delivery;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Webhook delivery ${deliveryId} did not finish.`);
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
  assert.deepEqual(await json(first), { items: [], groups: [] });

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
  const failedRun = await waitForRun(createdRun.run.id);
  assert.equal(failedRun.status, "failed");
  assert.match(failedRun.errorMessage, /GitHub source/i);

  const runsResponse = await json(await appFetch("/api/runs"));
  assert.equal(runsResponse.items.some((run) => run.id === createdRun.run.id), true);
});

test("GitHub authorization, ingestion, graph construction, and PR analysis form one real path", async () => {
  const connect = await appFetch("/api/github/connect", { redirect: "manual" });
  assert.equal(connect.status, 302);
  const installUrl = new URL(connect.headers.get("location"));
  assert.equal(installUrl.hostname, "github.com");
  assert.equal(installUrl.pathname, "/login/oauth/authorize");
  assert.equal(installUrl.searchParams.get("client_id"), "Iv1.test");
  assert.equal(
    installUrl.searchParams.get("redirect_uri"),
    "http://localhost/api/github/callback",
  );
  const state = installUrl.searchParams.get("state");
  assert.ok(state);

  const callback = await appFetch(
    `/api/github/callback?code=test-code&state=${encodeURIComponent(state)}`,
    { redirect: "manual" },
  );
  assert.equal(callback.status, 302);
  assert.equal(new URL(callback.headers.get("location")).searchParams.get("github_session"), state);

  const repositories = await json(
    await appFetch(`/api/github/repositories?session=${encodeURIComponent(state)}`),
  );
  assert.equal(repositories.items.length, 1);
  assert.equal(repositories.items[0].fullName, "acme/platform-api");

  const sourceResponse = await appFetch("/api/github/sources", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionState: state,
      repositoryId: "501",
      branch: "main",
    }),
  });
  assert.equal(sourceResponse.status, 201);
  const connected = await json(sourceResponse);
  assert.equal(connected.source.status, "connected");
  assert.equal(connected.source.artifactCount, 4);
  assert.equal(connected.source.codeArtifactCount, 2);
  assert.equal(connected.source.documentationArtifactCount, 2);
  assert.equal(githubBlobRequests, 4);

  const resync = await appFetch(`/api/sources/${connected.source.id}/sync`, {
    method: "POST",
  });
  assert.equal(resync.status, 200);
  assert.equal((await json(resync)).source.artifactCount, 4);
  assert.equal(githubBlobRequests, 4);

  const graph = await database.prepare("SELECT COUNT(*) AS count FROM relationships").first();
  assert.equal(graph.count >= 2, true);
  const sessionRecord = await database
    .prepare(
      "SELECT status, candidates_json AS candidatesJson FROM provider_connection_sessions WHERE provider = 'github' ORDER BY created_at DESC LIMIT 1",
    )
    .first();
  assert.equal(sessionRecord.status, "consumed");
  assert.equal(sessionRecord.candidatesJson.includes("ghu_test_user_token"), false);

  const analysisResponse = await appFetch("/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceId: connected.source.id, target: "#7" }),
  });
  assert.equal(analysisResponse.status, 202);
  const analysis = await json(analysisResponse);
  assert.equal(analysis.run.status, "queued");
  const completedAnalysis = await waitForRun(analysis.run.id);
  assert.equal(completedAnalysis.status, "succeeded");
  assert.equal(completedAnalysis.findingsCount, 2);

  const changesResponse = await json(await appFetch("/api/changes?status=open"));
  const pullChange = changesResponse.items.find((item) => item.title.includes("PR #7"));
  assert.ok(pullChange);
  assert.equal(pullChange.artifacts.length, 2);
  assert.equal(
    pullChange.artifacts.every((artifact) => artifact.externalUrl.includes("/blob/base123/")),
    true,
  );

});

test("signed GitHub webhooks create one automatic run and reject replays", async () => {
  const pullRequestPayload = {
    action: "synchronize",
    number: 7,
    installation: { id: 101 },
    repository: { full_name: "acme/platform-api" },
    sender: { login: "octocat" },
    pull_request: {
      number: 7,
      title: "Extend the refund window",
      html_url: "https://github.com/acme/platform-api/pull/7",
      updated_at: "2026-08-18T12:00:00.000Z",
      user: { login: "octocat" },
      base: { ref: "main", sha: "base123" },
      head: { ref: "refund-window", sha: "head789" },
    },
  };

  const invalid = await githubWebhook(
    "pull_request",
    "delivery-invalid-signature",
    pullRequestPayload,
    `sha256=${"0".repeat(64)}`,
  );
  assert.equal(invalid.status, 401);
  const invalidPersisted = await database
    .prepare("SELECT COUNT(*) AS count FROM webhook_deliveries WHERE provider_delivery_id = ?")
    .bind("delivery-invalid-signature")
    .first();
  assert.equal(invalidPersisted.count, 0);

  const unsupported = await githubWebhook("issues", "delivery-unsupported", {
    action: "opened",
    installation: { id: 101 },
    repository: { full_name: "acme/platform-api" },
  });
  assert.equal(unsupported.status, 202);
  assert.equal((await json(unsupported)).status, "ignored");
  assert.equal((await waitForDelivery("delivery-unsupported")).status, "ignored");

  const accepted = await githubWebhook(
    "pull_request",
    "delivery-pr-7",
    pullRequestPayload,
  );
  assert.equal(accepted.status, 202);
  const acceptedPayload = await json(accepted);
  assert.equal(acceptedPayload.duplicate, false);
  const automaticPullRun = await waitForRun(acceptedPayload.runId);
  assert.equal(automaticPullRun.status, "succeeded");
  assert.equal(automaticPullRun.trigger, "github");
  assert.equal(automaticPullRun.findingsCount, 2);
  assert.equal((await waitForDelivery("delivery-pr-7")).status, "processed");

  const duplicate = await githubWebhook(
    "pull_request",
    "delivery-pr-7",
    pullRequestPayload,
  );
  assert.equal(duplicate.status, 200);
  assert.equal((await json(duplicate)).duplicate, true);
  const uniqueRun = await database
    .prepare("SELECT COUNT(*) AS count FROM analysis_runs WHERE id = ?")
    .bind(acceptedPayload.runId)
    .first();
  assert.equal(uniqueRun.count, 1);

  const mismatchedReplay = await githubWebhook(
    "pull_request",
    "delivery-pr-7",
    {
      ...pullRequestPayload,
      pull_request: { ...pullRequestPayload.pull_request, title: "Different payload" },
    },
  );
  assert.equal(mismatchedReplay.status, 409);

  const push = await githubWebhook("push", "delivery-push-main", {
    ref: "refs/heads/main",
    before: "base122",
    after: "base123",
    compare: "https://github.com/acme/platform-api/compare/base122...base123",
    installation: { id: 101 },
    repository: { full_name: "acme/platform-api" },
    sender: { login: "writer" },
    pusher: { name: "writer" },
    commits: [
      { added: [], modified: ["docs/refunds.md"], removed: [] },
    ],
    head_commit: {
      message: "Clarify refund documentation",
      timestamp: "2026-08-18T12:05:00.000Z",
      added: [],
      modified: ["docs/refunds.md"],
      removed: [],
    },
  });
  assert.equal(push.status, 202);
  const pushPayload = await json(push);
  const automaticPushRun = await waitForRun(pushPayload.runId);
  assert.equal(automaticPushRun.status, "succeeded");
  assert.equal(automaticPushRun.findingsCount >= 1, true);
  assert.equal((await waitForDelivery("delivery-push-main")).status, "processed");
  const pushContext = await database
    .prepare(
      `SELECT ce.actor, ce.before_revision AS beforeRevision,
              ce.after_revision AS afterRevision, ar.target, ar.trigger
       FROM analysis_runs ar
       INNER JOIN change_events ce ON ce.id = ar.change_event_id
       WHERE ar.id = ?`,
    )
    .bind(pushPayload.runId)
    .first();
  assert.deepEqual(pushContext, {
    actor: "writer",
    beforeRevision: "base122",
    afterRevision: "base123",
    target: "main",
    trigger: "github",
  });

  const branchIgnored = await githubWebhook("push", "delivery-push-feature", {
    ref: "refs/heads/feature",
    before: "base123",
    after: "head999",
    installation: { id: 101 },
    repository: { full_name: "acme/platform-api" },
    commits: [],
  });
  assert.equal(branchIgnored.status, 202);
  assert.equal((await json(branchIgnored)).status, "ignored");

  const malformed = await githubWebhook("pull_request", "delivery-malformed", {
    action: "synchronize",
    number: 7,
    installation: { id: 101 },
    repository: { full_name: "acme/platform-api" },
  });
  assert.equal(malformed.status, 422);
  assert.equal((await waitForDelivery("delivery-malformed")).status, "failed");
});

async function authorizeConfluence(repositorySourceId) {
  const connect = await appFetch(
    `/api/confluence/connect?repository_source_id=${encodeURIComponent(repositorySourceId)}`,
    { redirect: "manual" },
  );
  assert.equal(connect.status, 302);
  const state = new URL(connect.headers.get("location")).searchParams.get("state");
  assert.ok(state);
  const callback = await appFetch(
    `/api/confluence/callback?code=confluence-code&state=${encodeURIComponent(state)}`,
    { redirect: "manual" },
  );
  assert.equal(callback.status, 302);
  assert.equal(
    new URL(callback.headers.get("location")).searchParams.get("confluence_session"),
    state,
  );
  const replayedCallback = await appFetch(
    `/api/confluence/callback?code=confluence-code&state=${encodeURIComponent(state)}`,
    { redirect: "manual" },
  );
  assert.equal(replayedCallback.status, 302);
  assert.equal(
    new URL(replayedCallback.headers.get("location")).searchParams.get("confluence_session"),
    state,
  );
  const spaces = await json(
    await appFetch(`/api/confluence/spaces?session=${encodeURIComponent(state)}`),
  );
  assert.equal(spaces.items[0].name, "Engineering");
  assert.equal(spaces.repositorySourceId, repositorySourceId);
  return state;
}

test("Confluence pages pair with a repository and reconnect idempotently", async () => {
  const repository = await database
    .prepare("SELECT id FROM sources WHERE provider = 'github' AND github_installation_id IS NOT NULL ORDER BY created_at LIMIT 1")
    .first();
  assert.ok(repository);

  const firstState = await authorizeConfluence(repository.id);
  const firstResponse = await appFetch("/api/confluence/sources", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionState: firstState, spaceId: "space-1" }),
  });
  assert.equal(firstResponse.status, 201);
  const first = await json(firstResponse);
  assert.equal(first.source.provider, "confluence");
  assert.equal(first.source.artifactCount, 2);
  assert.equal(first.alreadyTracked, false);
  assert.equal(first.associationAlreadyTracked, false);

  const secondState = await authorizeConfluence(repository.id);
  const secondResponse = await appFetch("/api/confluence/sources", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionState: secondState, spaceId: "space-1" }),
  });
  assert.equal(secondResponse.status, 201);
  const second = await json(secondResponse);
  assert.equal(second.source.id, first.source.id);
  assert.equal(second.alreadyTracked, true);
  assert.equal(second.associationAlreadyTracked, true);

  const listed = await json(await appFetch("/api/sources"));
  const group = listed.groups.find((item) => item.repository?.id === repository.id);
  assert.ok(group);
  assert.equal(group.documentation.length, 1);
  assert.equal(group.documentation[0].name, "Engineering");

  const artifacts = await database
    .prepare("SELECT COUNT(*) AS count FROM artifacts WHERE source_id = ?")
    .bind(first.source.id)
    .first();
  const associations = await database
    .prepare("SELECT COUNT(*) AS count FROM source_associations WHERE repository_source_id = ? AND documentation_source_id = ?")
    .bind(repository.id, first.source.id)
    .first();
  const token = await database
    .prepare("SELECT encrypted_access_token AS encryptedAccessToken FROM confluence_connections LIMIT 1")
    .first();
  const crossSourceRelationships = await database
    .prepare("SELECT COUNT(*) AS count FROM relationships WHERE type = 'documents'")
    .first();
  assert.equal(artifacts.count, 2);
  assert.equal(associations.count, 1);
  assert.equal(token.encryptedAccessToken.includes("atlassian-access-token"), false);
  assert.equal(crossSourceRelationships.count >= 2, true);

  const documentationAnalysisResponse = await appFetch("/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceId: first.source.id, target: "Refund policy" }),
  });
  assert.equal(documentationAnalysisResponse.status, 202);
  const documentationAnalysis = await json(documentationAnalysisResponse);
  assert.equal(documentationAnalysis.run.status, "queued");
  const completedDocumentationAnalysis = await waitForRun(documentationAnalysis.run.id);
  assert.equal(completedDocumentationAnalysis.status, "succeeded");
  assert.equal(completedDocumentationAnalysis.findingsCount, 2);

  const codeAnalysisResponse = await appFetch("/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceId: repository.id, target: "#7" }),
  });
  assert.equal(codeAnalysisResponse.status, 202);
  const codeAnalysis = await json(codeAnalysisResponse);
  const completedCodeAnalysis = await waitForRun(codeAnalysis.run.id);
  assert.equal(completedCodeAnalysis.status, "succeeded");
  assert.equal(completedCodeAnalysis.findingsCount, 3);

  const codeChange = (await json(await appFetch("/api/changes?status=open"))).items
    .find((item) => item.runId === codeAnalysis.run.id);
  assert.ok(codeChange);
  const confluenceFinding = codeChange.artifacts.find((item) => item.kind === "Confluence");
  assert.ok(confluenceFinding);
  assert.equal(confluenceFinding.externalUrl.includes("acme.atlassian.net/wiki/"), true);
  assert.equal(confluenceFinding.externalUrl.includes("#L"), false);

  const removalResponse = await appFetch(`/api/sources/${repository.id}`, {
    method: "DELETE",
  });
  assert.equal(removalResponse.status, 200);
  assert.equal((await json(removalResponse)).removedSourceId, repository.id);
  const preservedRun = await waitForRun(codeAnalysis.run.id);
  assert.equal(preservedRun.status, "succeeded");
  const preservedEvidence = await database
    .prepare(
      `SELECT fe.artifact_version_id AS artifactVersionId, fe.source_url AS sourceUrl
       FROM finding_evidence fe
       INNER JOIN findings f ON f.id = fe.finding_id
       WHERE f.run_id = ? AND fe.source_url LIKE 'https://github.com/%'
       LIMIT 1`,
    )
    .bind(documentationAnalysis.run.id)
    .first();
  assert.equal(preservedEvidence.artifactVersionId, null);
  assert.equal(preservedEvidence.sourceUrl.includes("/blob/base123/"), true);
});
