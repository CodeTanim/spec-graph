# SpecGraph

**Know when a software change may have made related code or documentation outdated.**

[Open the live SpecGraph app](https://spec-graph.vercel.app)

SpecGraph connects sources that should stay aligned, such as a GitHub
repository and a Confluence space. It checks them once per day or whenever you
choose **Analyze**, then shows what changed, what may need attention, and the
evidence behind each suggestion.

SpecGraph never edits your code or documentation. A person always reviews the
result and decides whether to resolve or dismiss it.

## Why SpecGraph exists

Software changes quickly, but the pages and files that explain it can easily
fall behind. SpecGraph helps a team find that gap before outdated information
confuses a customer or coworker.

## How it works

1. Add a code or documentation source.
2. Connect sources that describe the same product or system.
3. SpecGraph checks them daily, or immediately when you select **Analyze**.
4. Review any likely impact with links to the changed item and its supporting evidence.
5. Mark the suggestion resolved or dismiss it.

A connected group means “look for relationships among these sources.” It does
not mean that every file is related to every page. SpecGraph only raises a
suggestion when it finds artifact-level evidence.

## Example

Imagine a required field changes in a payments API. SpecGraph can find a
Confluence page that still describes the old request and link the reviewer to
both the API change and the related page.

## What works today

- GitHub repositories
- Markdown and OpenAPI documentation stored in a repository
- Confluence spaces
- Equal, provider-neutral groups of connected sources
- Code-to-documentation, documentation-to-code, and documentation-to-documentation impact checks when a verified relationship exists
- Daily automatic checks and immediate manual checks
- Evidence links for every suggestion
- Persisted review actions and run history

Notion and Google Docs appear in the product roadmap but are not connected yet.

## What SpecGraph does not do

- It does not automatically rewrite or publish anything.
- It does not assume that every item in a connected group affects every other item.
- It does not present uncertain guesses without showing why they were raised.

## For developers

### Technology

- Next.js 16 and React 19
- Auth.js with GitHub sign-in
- Neon Postgres with Drizzle ORM
- Vercel Workflow and Cron for durable manual and daily checks
- A GitHub App and read-only Confluence OAuth connector
- Vitest, Testing Library, and PGlite for component and database integration tests

### Local setup

Requirements: Node.js 22 and a Neon-compatible Postgres database.

```bash
npm install
cp .env.example .env.local
npm run db:migrate
npm run dev
```

Fill in `.env.local` before migrating. Use the pooled `DATABASE_URL` for the app
and the direct `DATABASE_URL_UNPOOLED` for migrations. Generate `AUTH_SECRET`
and `CONNECTOR_ENCRYPTION_KEY` with cryptographically secure random values.
Provider private keys and secrets must remain in local or hosting environment
variables; never commit them.

Set `CRON_SECRET` in Vercel Production. It authorizes the daily job that checks
queued GitHub changes and polls connected Confluence spaces. The job runs at
13:00 UTC; manual Analyze requests start immediately.

When no GitHub client ID is configured outside production, local development
uses a development-only identity. Production always requires GitHub sign-in.

### GitHub App URLs

For a deployment at `https://your-domain.example`, configure:

- Homepage: `https://your-domain.example`
- User sign-in callback: `https://your-domain.example/api/auth/callback/github`
- Repository connection callback: `https://your-domain.example/api/github/callback`
- Webhook: `https://your-domain.example/api/github/webhook`

The GitHub App needs read access to contents, metadata, and pull requests, plus
push and pull-request webhook events.

### Commands

- `npm run dev` — start the development server
- `npm run build` — compile the production app and durable workflows
- `npm test` — run component and Postgres integration tests
- `npm run test:evaluation` — run reviewed relationship-quality fixtures
- `npm run lint` — run ESLint
- `npm run db:generate` — generate a Postgres migration for review
- `npm run db:migrate` — apply migrations using `.env.local`
- `npm run db:studio` — inspect the database with Drizzle Studio

### Runtime flow

1. Auth.js resolves a GitHub identity and SpecGraph creates a tenant-scoped workspace.
2. Each connected source receives a provider-neutral source group; adding a peer joins that same group.
3. A durable sync normalizes code, tests, repository docs, OpenAPI, and Confluence pages into artifacts.
4. Deterministic analysis builds evidence-backed relationships inside the relevant group.
5. Findings, evidence, run state, and review actions persist in Postgres and appear in one feed.

Group membership limits where SpecGraph looks; it is not itself evidence. The
current analyzer uses imports, exports, test names, Markdown links and headings,
exact paths, and structured OpenAPI operations and schemas. Traversal is capped
at two verified relationship steps and suppresses unrelated or weaker
duplicates. Semantic contradiction checking is a later package.

### Deployment

The live non-commercial deployment is [spec-graph.vercel.app](https://spec-graph.vercel.app).
The repository is linked to Vercel and Neon. Vercel environment variables must
contain the database, Auth.js, GitHub App, and optional Confluence secrets.
Apply reviewed Drizzle migrations before promoting code that depends on them.

See [SPECGRAPH_MVP_IMPLEMENTATION_PLAN.md](./SPECGRAPH_MVP_IMPLEMENTATION_PLAN.md)
for scope, acceptance gates, current status, and remaining work.
