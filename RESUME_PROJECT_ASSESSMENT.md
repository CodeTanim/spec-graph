# SpecGraph Resume Project Assessment

Updated: August 15, 2026

## Decision

SpecGraph is an excellent project concept for the Software Engineer II resume, but the current implementation is not yet strong enough to replace an existing project.

- Concept fit: 9/10
- Current resume readiness: 4/10
- Potential as a flagship project: 9/10

Once it performs genuine end-to-end change-impact analysis, SpecGraph should replace Incorrupto immediately and could become the first project on both the default SWE II and AI-focused resumes. With sufficient depth, it could also replace Rehearse as the primary independent product.

## Why SpecGraph Complements the Experience Section

The Capital One experience already establishes production full-stack development, payments, AWS, infrastructure migration, resiliency, messaging, data pipelines, and operational ownership. SpecGraph can add signals that are not yet as visible:

- Independent product and architecture ownership outside an employer
- Developer tooling rather than another financial workflow
- React and Next.js depth beyond the Angular work stack
- External GitHub and Confluence integrations
- Graph-based dependency and change-impact analysis
- AI/LLM retrieval, ranking, explanation, and evaluation
- Cloudflare Workers and edge-oriented architecture
- A public repository, deployment, and verifiable demonstration

The product should be explainable in one sentence:

> When code or a specification changes, SpecGraph identifies which tests, documentation, APIs, and related artifacts may require updates and explains the supporting evidence.

## Current Implementation

The repository now has a durable application foundation, but it is not yet a functioning change-impact platform because source ingestion and analysis have not been implemented.

What currently exists:

- Responsive Next.js/React interface for changes, analysis runs, connected sources, details, and evidence
- Accessible dialogs, filters, navigation, and interactive states
- Component tests with Vitest and Testing Library
- Server-rendered HTML tests
- Cloudflare/vinext build and deployment scaffolding
- Stable authenticated-user identity and idempotent personal workspace creation
- A 15-table Drizzle/D1 product schema with an inspected initial migration
- Workspace-scoped repositories and APIs for changes, runs, sources, and finding actions
- A production UI that reads server data, persists review actions, and contains no demo records
- Built-worker integration tests covering persistence, immutable evidence links, and tenant isolation

Current limitations:

- No GitHub or Confluence source can be connected yet.
- Manual Analyze creates a durable queued run, but no background worker processes it yet.
- There is no repository ingestion or parsing pipeline.
- There is no dependency graph, impact-analysis engine, semantic retrieval, or LLM analysis.
- Findings and evidence can be persisted and served, but no real analyzer produces them yet.
- Tests validate the persistence and API foundation, but not analysis correctness.
- The README still describes the generic vinext starter.
- No Git remote or public repository link is currently configured.

The strongest accurate description of the current state would be:

> Built the authenticated, tenant-scoped application foundation for a software change-impact platform, with D1 persistence, API-backed workflows, immutable evidence links, and integration-tested review state.

That is not yet differentiated enough for the target resume.

## Minimum Resume-Worthy End-to-End Flow

SpecGraph should implement at least one complete production-style path:

```text
GitHub push, pull request, Confluence edit, or manual run
        ↓
Parse changed code, specifications, and documentation
        ↓
Build or update a dependency graph
        ↓
Identify potentially affected artifacts
        ↓
Rank findings and attach source evidence
        ↓
Persist and display results
```

Minimum capabilities:

1. A real GitHub integration using signed webhooks or a GitHub App.
2. Automatic ingestion of Markdown, MDX, README, and OpenAPI documentation inside connected repositories.
3. A real external documentation connection, starting with read-only Confluence site and space access.
4. A provider-neutral ingestion model that normalizes repository files and Confluence pages into the same artifact system.
5. A typed graph containing files, symbols, endpoints, documentation sections, tests, and their relationships across sources.
6. Diff- or revision-to-node mapping followed by dependency traversal and impact ranking.
7. Persistent analysis runs, findings, evidence, and status transitions.
8. Background processing with retries, idempotency, and failure recovery.
9. Findings linked to exact source files, document pages or versions, locations, and evidence.
10. A public deployment and professionally documented demonstration repository.
11. A labeled evaluation set reporting precision, recall, false-positive rate, and analysis latency.

## Source Connection and User Experience

External documentation is part of the product promise, but connecting it should remain progressive and understandable:

1. The user connects a GitHub repository and tracked branch.
2. SpecGraph automatically includes documentation already stored in that repository.
3. SpecGraph asks, **Where are your docs?** and offers **Connect Confluence** or **Not now**.
4. GitHub and Confluence appear as plain connected sources with simple preparing, connected, or needs-attention states.
5. Code-first and documentation-first findings appear in one Changes feed and use the same review workflow.

Users should not need to understand provider adapters, ingestion, graph construction, synchronization cursors, webhooks, queues, or model selection. Those remain implementation details.

The engineering sequence remains GitHub-first so the core pipeline can be proven with repository-hosted documentation. Confluence follows through the same provider-neutral contracts and is required before the complete MVP is considered resume-ready.

## Recommended Technical Direction

Use deterministic analysis for explicit relationships and an AI layer for semantic relationships:

- Parse imports, references, tests, schemas, and API contracts to create reliable graph edges.
- Use embeddings or an LLM to propose semantic links between code, documentation, and specifications.
- Require source evidence for every semantic finding.
- Rank results using edge type, graph distance, change scope, and semantic confidence.
- Keep deterministic and model-derived findings distinguishable in the data model and interface.
- Evaluate the system on labeled changes rather than relying on subjective demonstrations.

This hybrid approach is more technically credible than treating the LLM as the complete dependency engine.

## Production-Quality Signals to Demonstrate

- GitHub webhook signature validation
- Secure Confluence authorization and page-version handling
- Secure handling of installation or OAuth tokens
- Idempotent processing of duplicate webhook deliveries
- Retry and dead-letter handling for failed analyses
- Structured logs, traces, and analysis timing
- Rate limiting and repository access controls
- Unit tests for parsers and graph traversal
- Integration tests for ingestion through persisted findings
- Evaluation tests that detect changes in ranking quality
- Documented architectural decisions and limitations

## Metrics to Collect

Use measured results rather than estimates wherever possible:

- Repositories and pull requests analyzed
- GitHub repositories and Confluence spaces connected
- Repository files and Confluence pages synchronized
- Files, symbols, endpoints, documents, tests, nodes, and edges indexed
- End-to-end analysis latency
- Incremental update time after a pull request
- Precision, recall, and false-positive rate on labeled changes
- Percentage of findings with exact source evidence
- Analysis failures, retry rate, and successful recovery rate
- Active users or external testers
- Findings reviewed, accepted, dismissed, or acted upon

## Candidate Resume Bullets After Implementation

These are structural examples only. Replace every placeholder with measured and defensible results.

> Built and deployed SpecGraph, a change-impact analysis platform that ingests GitHub diffs and Confluence revisions and constructs a typed dependency graph across source code, OpenAPI specifications, documentation, and tests using Next.js, Cloudflare Workers, D1, and Drizzle.

> Designed a hybrid graph and LLM ranking pipeline evaluated against X labeled repository changes, achieving X% precision and X% recall while analyzing repositories containing X files in under X seconds.

Do not use these bullets until the described system and measurements exist.

## Portfolio Placement

### Default SWE II resume

1. SpecGraph — flagship independent developer-tooling product
2. One technically distinct project demonstrating AI/ML, distributed systems, Rust, search/retrieval, real-time collaboration, or another capability not already shown at Capital One

### AI-focused SWE II resume

1. SpecGraph — hybrid graph/LLM change-impact analysis with evaluations and evidence
2. A second AI or ML systems project demonstrating a distinct area such as agent orchestration, retrieval infrastructure, model serving, inference optimization, or multimodal systems

## Readiness Checklist

SpecGraph is ready for the resume when most of the following are true:

- [ ] At least one real repository can be connected.
- [ ] Repository-hosted documentation is included automatically.
- [ ] At least one real external Confluence documentation source can be connected.
- [ ] A webhook or manual run performs genuine backend analysis.
- [ ] Code-first and external-documentation-first changes use the same analysis and feed workflow.
- [ ] Results are persisted and survive a page reload.
- [ ] Findings are derived from a real dependency graph or semantic analysis.
- [ ] Every displayed finding includes verifiable source evidence.
- [ ] The analysis pipeline has automated unit and integration tests.
- [ ] A labeled evaluation reports quality and latency metrics.
- [ ] Authentication and GitHub/Confluence source access are handled securely.
- [ ] The product is deployed at a stable public or recruiter-accessible URL.
- [ ] The repository has a project-specific README with setup, architecture, screenshots, limitations, and evaluation results.
- [ ] The repository is public or otherwise available for recruiter verification.
- [ ] Resume bullets use only implemented capabilities and measured results.
