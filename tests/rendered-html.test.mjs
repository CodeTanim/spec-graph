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

test("server-renders the SpecGraph change inbox", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>SpecGraph — Change impact, explained<\/title>/i);
  assert.match(html, /Change Inbox/);
  assert.match(html, /Refund validation window changed/);
  assert.match(html, /Customer Refund Guide/);
  assert.match(html, /openapi\.yaml/);
  assert.match(html, /Analyze now/);
  assert.match(html, /<span>Sources<\/span>/);
  assert.doesNotMatch(html, /codex-preview/);
  assert.doesNotMatch(html, /react-loading-skeleton/);
  assert.doesNotMatch(html, /Your site is taking shape/);
});

test("renders accessible controls for the primary workflow", async () => {
  const response = await render();
  const html = await response.text();

  assert.match(html, /aria-label="Primary navigation"/);
  assert.match(html, /aria-label="Search changes"/);
  assert.match(html, /aria-label="Change filters"/);
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /Review impact/);
  assert.match(html, /role="status"/);
});
