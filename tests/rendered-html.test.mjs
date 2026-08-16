import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import { Miniflare } from "miniflare";

let miniflare;

before(() => {
  miniflare = new Miniflare({
    modules: true,
    scriptPath: fileURLToPath(
      new URL("../dist/server/index.js", import.meta.url),
    ),
    modulesRules: [{ type: "ESModule", include: ["**/*.js"] }],
    compatibilityDate: "2026-05-22",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "specgraph-render-test" },
    serviceBindings: {
      ASSETS: async () => new Response("Not found", { status: 404 }),
    },
  });
});

after(async () => {
  await miniflare?.dispose();
});

async function render() {
  return miniflare.dispatchFetch("http://localhost/", {
    headers: { accept: "text/html" },
  });
}

test("server-renders the authenticated SpecGraph application shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>SpecGraph — Change impact, explained<\/title>/i);
  assert.match(html, /Checking your workspace/);
  assert.match(html, /Open/);
  assert.match(html, /All/);
  assert.match(html, />Analyze</);
  assert.doesNotMatch(html, /Refund validation window changed/);
  assert.doesNotMatch(html, /Alex Kim/);
  assert.doesNotMatch(html, /High impact/);
  assert.doesNotMatch(html, /High-confidence evidence/);
  assert.doesNotMatch(html, /Customer Refund Guide/);
  assert.doesNotMatch(html, /codex-preview/);
  assert.doesNotMatch(html, /react-loading-skeleton/);
  assert.doesNotMatch(html, /Your site is taking shape/);
});

test("renders accessible controls for the minimal workflow", async () => {
  const response = await render();
  const html = await response.text();

  assert.match(html, /aria-label="Main navigation"/);
  assert.match(html, /aria-label="Change filters"/);
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /aria-label="Detected changes"/);
  assert.match(html, /role="status"/);
});
