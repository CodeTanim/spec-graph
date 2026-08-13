import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the simplified SpecGraph change list", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>SpecGraph — Change impact, explained<\/title>/i);
  assert.match(html, /3 changes need your attention/);
  assert.match(html, /Refund validation window changed/);
  assert.match(html, /Open/);
  assert.match(html, /All/);
  assert.match(html, />Analyze</);
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
