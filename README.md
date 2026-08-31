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
- Exact identifier and API-operation matching across code and documentation
- Confidence-ranked results that can combine independent links, paths, imports, and entity matches
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
- PostgreSQL with Drizzle ORM (provider-neutral; Supabase and Neon are supported)
- Vercel Workflow and Cron for durable manual and daily checks
- A GitHub App and read-only Confluence OAuth connector
- Vitest, Testing Library, and PGlite for component and database integration tests

### Local setup

Requirements: Node.js 22 and a PostgreSQL database.

```bash
npm install
cp .env.example .env.local
npm run db:migrate
npm run dev
```

Fill in `.env.local` before migrating. Use the pooled `DATABASE_URL` for the app
and the direct `DATABASE_URL_UNPOOLED` for migrations. Vercel's Supabase
integration supplies the equivalent `POSTGRES_URL` and
`POSTGRES_URL_NON_POOLING` names automatically; SpecGraph accepts either pair.
Keep the production database variables scoped to Vercel Production. Give
Preview its own Supabase project or database branch, and use a separate local
database for Development. Set `DATABASE_DEPLOYMENT_ENVIRONMENT` to
`production`, `preview`, or `development` beside each URL; SpecGraph then stops
startup if a deployment is pointed at a database labeled for another
environment.
Generate `AUTH_SECRET` and `CONNECTOR_ENCRYPTION_KEY` with cryptographically
secure random values.
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
exact paths, exact code identifiers, shared documentation entities, and
structured OpenAPI operations and schemas. Traversal is capped at two verified
relationship steps and suppresses unrelated or weaker duplicates.

The semantic layer now has a bounded, versioned interface, combined confidence
ranking, exact-excerpt verification, safe fallback, and token telemetry. An
opt-in Vercel AI Gateway adapter can evaluate ambiguous candidates with strict
structured output. Runtime ingestion now stores private, version-pinned,
bounded change scopes for new and modified GitHub files and Confluence pages,
separate from the public feed payload. The semantic adapter can consume only a
matching scope and fails closed when that evidence is unavailable or belongs to
a different artifact. Private snippets are redacted immediately when a source
is removed and after 30 days during the daily maintenance workflow. Live
production AI findings remain disabled until an
unseen holdout validates quality plus the provisional candidate limit;
deterministic findings remain live in the deployed app.

Two ingestion limits remain explicit: deleted artifacts do not yet have a
complete tombstone lifecycle for downstream findings, and Confluence sync does
not yet paginate spaces containing more than 100 pages.

### Local analysis evaluation

The repository includes a network-free evaluation lab in
[`evaluation`](./evaluation). Markdown files simulate natural-language
Confluence pages, repository fixtures simulate the related implementation, and
25 reviewed changes define what should or should not be flagged. It covers
code-first, documentation-first, OpenAPI, test, unrelated, and ambiguous cases
without touching OAuth, the live Confluence space, or production data.

This 25-case/23-target corpus is an **in-sample calibration and regression
set**, not an unseen holdout. Its labels, retrieval rules, and semantic prompt
examples were refined against these cases. Results on it show that the current
implementation fits the reviewed product policy; they do not by themselves
measure generalization to unfamiliar repositories or documentation styles.

`npm run test:evaluation` reports two deliberately separate layers:

- candidate retrieval — whether the correct artifact reaches the bounded review set;
- final decisions — precision, recall, F1, and false-positive rate for a future analyzer using the same labels.

The section-aware retrieval baseline is recorded in
[`evaluation/BASELINE.md`](./evaluation/BASELINE.md). The current adjudicated
corpus contains 23 relationships worth showing to a user. All 23 reach the
bounded review set and all 23 rank in its top three, with 2.32 candidates per
case on average. Neither explicitly unrelated case produces a candidate.
Documentation-first review omits tests as separate targets; the UI gives one
reminder to review related tests when it suggests a production code file.
The three-candidate cap is provisional: the calibration set does not yet
contain a realistic change with more than three legitimate affected targets.

Code-first evaluation cases provide an atomic changed scope—the relevant
function, constant, or diff-sized excerpt—rather than claiming that every
behavior in the current file changed. This is already enforced in the local
evaluation lab. Production GitHub and Confluence ingestion now persists the
equivalent private, version-pinned before/after scope, and the semantic adapter
can consume it with fail-closed validation. That adapter is still deliberately
disconnected from live production findings until the unseen-holdout release
gate passes.

To measure a real structured-output model without changing production behavior,
set `SPECGRAPH_SEMANTIC_MODEL` to a current Vercel AI Gateway `provider/model`
ID, authenticate with either `AI_GATEWAY_API_KEY` or Vercel OIDC, and run
`npm run test:evaluation:semantic`. This makes 25 sequential, bounded model
calls and reports precision, recall, F1, false-positive rate, latency, and token
usage. `SPECGRAPH_SEMANTIC_EVAL_CASES` can select inexpensive diagnostic cases;
targeted runs never satisfy the release gate. Set
`SPECGRAPH_SEMANTIC_EVAL_RUNS=3` for an in-sample stability diagnostic; repeated
runs on the calibrated corpus are not a substitute for an unseen holdout.

The live adapter uses deterministic generation, separate relationship and
ownership classifications, exact evidence passage IDs, and byte-exact evidence
verification. Its privacy-safe traces contain IDs and numeric/status metadata
only—not source text, prompts, excerpts, model summaries, or URLs. Each case
makes one provider request without hidden SDK retries. A Gateway free tier may
not admit the complete run; set `SPECGRAPH_SEMANTIC_EVAL_DELAY_MS` to match the
account limit. The ordinary test and retrieval-evaluation commands remain
network-free.

Historical live measurements and the current deterministic retrieval result are recorded in
[`evaluation/BASELINE.md`](./evaluation/BASELINE.md). Production enablement
requires a versioned unseen holdout that was not used to tune prompts,
thresholds, retrieval, or labels. That holdout must include a case with more
than three legitimate impacts so the candidate cap can be validated or revised.
Repeated runs must also reach at least 95% precision and 85% recall, detect every
critical relationship, use no provider fallback, and receive the same atomic
changed-scope contract from the runtime pipeline. Until all of those conditions
hold, the live product continues to show deterministic findings.

### Deployment

The live non-commercial deployment is [spec-graph.vercel.app](https://spec-graph.vercel.app).
The repository is linked to Vercel and uses a portable PostgreSQL connection.
Vercel environment variables must contain the database, Auth.js, GitHub App,
and optional Confluence secrets.
Apply reviewed Drizzle migrations before promoting code that depends on them.

To keep database transfer bounded, the runtime reads only current artifact
versions during sync, reuses persisted evidence excerpts in the feed, batches
dashboard counts, skips graph rebuilds when a source revision is unchanged,
and progressively backs off active-run polling. Historical artifact bodies are
retained according to the revision-retention policy rather than loaded into
ordinary dashboard requests.

Current analysis quality and release-gate results are recorded in
[evaluation/BASELINE.md](./evaluation/BASELINE.md).
