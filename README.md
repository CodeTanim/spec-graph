# SpecGraph

SpecGraph detects when code and documentation drift apart, then explains what
may need updating with exact, revision-linked evidence.

The MVP keeps the product surface intentionally small: connect a GitHub
repository and optional Confluence documentation, watch one feed of detected
changes, or start an analysis manually.

## Stack

- Next.js 16 and React 19
- Auth.js with GitHub sign-in
- Neon Postgres with Drizzle ORM
- Vercel Workflow for durable daily source checks and manual runs
- GitHub App and read-only Confluence OAuth connectors
- Vitest, Testing Library, and PGlite for component and Postgres integration tests

## Local setup

Requirements: Node.js 22 and a Neon-compatible Postgres database.

```bash
npm install
cp .env.example .env.local
npm run db:migrate
npm run dev
```

Fill in `.env.local` before migrating. Use the pooled `DATABASE_URL` for the app
and the direct `DATABASE_URL_UNPOOLED` for migrations. Generate `AUTH_SECRET`
with a cryptographically secure random value. Provider private keys and secrets
must stay in local or hosting environment variables; never commit them.

Set `CRON_SECRET` to a random value in Vercel Production. Vercel uses it to
authorize the daily cron request. That workflow checks queued GitHub changes
and connected Confluence spaces once per day. Manual Analyze requests still
start immediately. The automatic check runs at 13:00 UTC (morning in Eastern
Time).

When no GitHub client ID is configured outside production, local development
uses a development-only identity. Production always requires GitHub sign-in.

## GitHub App URLs

For a deployment at `https://your-domain.example`, configure:

- Homepage: `https://your-domain.example`
- User sign-in callback: `https://your-domain.example/api/auth/callback/github`
- Repository connection callback: `https://your-domain.example/api/github/callback`
- Webhook: `https://your-domain.example/api/github/webhook`

The GitHub App needs read access to contents, metadata, and pull requests, plus
push and pull-request webhook events.

## Commands

- `npm run dev` — start the Next.js development server
- `npm run build` — compile the production app and durable workflows
- `npm test` — run component and Postgres integration tests
- `npm run test:evaluation` — run the reviewed deterministic relationship fixtures and quality assertions
- `npm run lint` — run ESLint
- `npm run db:generate` — generate a reviewed Postgres migration
- `npm run db:migrate` — apply migrations using `.env.local`
- `npm run db:studio` — inspect the database with Drizzle Studio

## Runtime flow

1. Auth.js resolves a GitHub identity and SpecGraph creates one tenant-scoped workspace.
2. A source connection stores provider metadata, then queues a durable sync.
3. Sync normalizes code, tests, repository docs, OpenAPI, or Confluence pages into artifacts and relationships.
4. Signed GitHub webhooks record changes immediately; the daily workflow batches
   automatic analysis and polls Confluence page versions once per day. Manual
   requests still run immediately.
5. Findings, evidence links, run state, and review actions persist in Postgres and appear in the same minimal feed.

The current analyzer deliberately starts with deterministic imports, exports,
test naming, Markdown links and headings, exact paths, and structured OpenAPI
references. Candidate traversal is capped at two verified relationship steps,
ranks stronger evidence first, stops code-driven searches at the first
documentation boundary, and suppresses unrelated or weaker duplicates.
OpenAPI JSON and YAML are parsed into operations and schemas; version diffs
identify contract facts such as newly required fields, then only documentation
naming the changed operation or schema is flagged. Semantic contradiction
checking remains a later package, after the deterministic baseline is expanded
beyond the reviewed starter fixtures.

## Deployment

The repository is linked to Vercel and Neon. Vercel environment variables must
contain the database, Auth.js, GitHub App, and optional Confluence secrets before
deployment. Drizzle migrations are applied separately before the new app version
is promoted.

See [SPECGRAPH_MVP_IMPLEMENTATION_PLAN.md](./SPECGRAPH_MVP_IMPLEMENTATION_PLAN.md)
for scope, acceptance gates, current status, and remaining work.
