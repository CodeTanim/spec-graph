"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type View = "inbox" | "runs" | "sources" | "settings";
type Filter = "all" | "needs-review" | "processing";
type ReviewState = "needs-review" | "processing" | "resolved";

type Artifact = {
  name: string;
  kind: "Confluence" | "OpenAPI" | "Test" | "Markdown" | "Code";
  location: string;
  excerpt: string;
};

type ChangeItem = {
  id: string;
  title: string;
  source: string;
  time: string;
  severity: "High impact" | "Medium impact" | "Low impact" | "Processing";
  affected: number;
  reviewState: ReviewState;
  confidence: string;
  relation: "affects" | "may affect" | "references";
  trigger: "Webhook" | "Scheduled" | "Manual";
  summary: string;
  artifacts: Artifact[];
};

const initialChanges: ChangeItem[] = [
  {
    id: "01",
    title: "Refund validation window changed",
    source: "src/refunds/policy.ts",
    time: "12 min ago",
    severity: "High impact",
    affected: 4,
    reviewState: "needs-review",
    confidence: "High-confidence evidence",
    relation: "affects",
    trigger: "Webhook",
    summary:
      "The refund eligibility window changed from 30 to 60 days. Four connected resources still describe or test the previous behavior.",
    artifacts: [
      {
        name: "Customer Refund Guide",
        kind: "Confluence",
        location: "Customer Operations / Refunds § Eligibility",
        excerpt: "Refunds are available within 30 days of the original charge.",
      },
      {
        name: "openapi.yaml",
        kind: "OpenAPI",
        location: "api/openapi.yaml · RefundEligibility",
        excerpt: "maximumWindowDays: 30",
      },
      {
        name: "refund-window.test.ts",
        kind: "Test",
        location: "tests/refunds/refund-window.test.ts · line 42",
        excerpt: "expect(isEligible(charge, 31)).toBe(false)",
      },
      {
        name: "Mobile integration guide",
        kind: "Markdown",
        location: "docs/mobile/refunds.md § Eligibility",
        excerpt: "Requests older than 30 days return REFUND_WINDOW_EXPIRED.",
      },
    ],
  },
  {
    id: "02",
    title: "Reason is now required for refund requests",
    source: "api/openapi.yaml",
    time: "34 min ago",
    severity: "High impact",
    affected: 5,
    reviewState: "needs-review",
    confidence: "Direct schema evidence",
    relation: "affects",
    trigger: "Webhook",
    summary:
      "The RefundRequest schema now requires reason. Request examples, client validation, and three tests do not provide the field.",
    artifacts: [
      {
        name: "Refund SDK",
        kind: "Code",
        location: "packages/sdk/src/refunds.ts · createRefund",
        excerpt: "createRefund({ transactionId })",
      },
      {
        name: "API request docs",
        kind: "Markdown",
        location: "docs/api/refunds.md § Request body",
        excerpt: '{ "transactionId": "txn_123" }',
      },
      {
        name: "3 tests",
        kind: "Test",
        location: "tests/refunds/",
        excerpt: "Three fixtures construct RefundRequest without a reason.",
      },
    ],
  },
  {
    id: "03",
    title: "Webhook retry behavior adjusted",
    source: "worker/retry.ts",
    time: "2h ago",
    severity: "Medium impact",
    affected: 3,
    reviewState: "processing",
    confidence: "2 supporting references",
    relation: "may affect",
    trigger: "Webhook",
    summary:
      "Backoff timing and the maximum attempt count changed. SpecGraph is validating three possible downstream references.",
    artifacts: [
      {
        name: "Webhook delivery guide",
        kind: "Markdown",
        location: "docs/webhooks/delivery.md § Retries",
        excerpt: "Failed deliveries are retried five times over 24 hours.",
      },
      {
        name: "retry-policy.test.ts",
        kind: "Test",
        location: "worker/retry-policy.test.ts",
        excerpt: "expect(schedule).toHaveLength(5)",
      },
      {
        name: "Ops runbook",
        kind: "Confluence",
        location: "Operations / Webhook recovery",
        excerpt: "Escalate after the fifth failed delivery.",
      },
    ],
  },
  {
    id: "04",
    title: "Authentication guide wording updated",
    source: "Confluence / Authentication",
    time: "yesterday",
    severity: "Low impact",
    affected: 1,
    reviewState: "resolved",
    confidence: "Text-match evidence",
    relation: "references",
    trigger: "Scheduled",
    summary:
      "A documentation-only clarification may also belong in the repository README.",
    artifacts: [
      {
        name: "README / Authentication",
        kind: "Markdown",
        location: "README.md § Authentication",
        excerpt: "Use a workspace API token to authenticate every request.",
      },
    ],
  },
  {
    id: "05",
    title: "Payout response schema expanded",
    source: "api/openapi.yaml",
    time: "yesterday",
    severity: "Medium impact",
    affected: 2,
    reviewState: "needs-review",
    confidence: "Direct schema evidence",
    relation: "affects",
    trigger: "Webhook",
    summary:
      "The response now includes settlementStatus, while two examples still show the previous shape.",
    artifacts: [
      {
        name: "Payout API guide",
        kind: "Markdown",
        location: "docs/api/payouts.md § Response",
        excerpt: '{ "id": "po_123", "amount": 4200 }',
      },
      {
        name: "payout.fixture.ts",
        kind: "Test",
        location: "tests/fixtures/payout.fixture.ts",
        excerpt: "export const settledPayout = { id, amount }",
      },
    ],
  },
  {
    id: "06",
    title: "Settlement runbook owner changed",
    source: "Confluence / Settlement Operations",
    time: "2 days ago",
    severity: "Low impact",
    affected: 1,
    reviewState: "resolved",
    confidence: "Explicit owner reference",
    relation: "references",
    trigger: "Scheduled",
    summary: "The runbook ownership changed from Payments Core to Money Movement.",
    artifacts: [
      {
        name: "CODEOWNERS",
        kind: "Code",
        location: ".github/CODEOWNERS · line 18",
        excerpt: "/settlement/ @acme/payments-core",
      },
    ],
  },
];

const navItems: { id: View; label: string }[] = [
  { id: "inbox", label: "Inbox" },
  { id: "runs", label: "Runs" },
  { id: "sources", label: "Sources" },
  { id: "settings", label: "Settings" },
];

function Arrow() {
  return <span aria-hidden="true">↗</span>;
}

export default function Home() {
  const [activeView, setActiveView] = useState<View>("inbox");
  const [filter, setFilter] = useState<Filter>("all");
  const [changes, setChanges] = useState<ChangeItem[]>(initialChanges);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [selectedChange, setSelectedChange] = useState<ChangeItem | null>(null);
  const [selectedArtifact, setSelectedArtifact] = useState<Artifact | null>(null);
  const [analyzeOpen, setAnalyzeOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [nightlyScan, setNightlyScan] = useState(true);
  const [reviewAlerts, setReviewAlerts] = useState(true);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setAnalyzeOpen(false);
      setSelectedChange(null);
      setSelectedArtifact(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const counts = useMemo(
    () => ({
      all: changes.length,
      needsReview: changes.filter((item) => item.reviewState === "needs-review")
        .length,
      processing: changes.filter((item) => item.reviewState === "processing")
        .length,
    }),
    [changes],
  );

  const visibleChanges = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return changes.filter((item) => {
      if (filter === "needs-review" && item.reviewState !== "needs-review") {
        return false;
      }
      if (filter === "processing" && item.reviewState !== "processing") {
        return false;
      }
      if (!normalized) return true;
      const searchable = [
        item.title,
        item.source,
        item.summary,
        ...item.artifacts.map((artifact) => artifact.name),
      ]
        .join(" ")
        .toLowerCase();
      return searchable.includes(normalized);
    });
  }, [changes, filter, query]);

  function showArtifact(change: ChangeItem, artifact: Artifact) {
    setSelectedChange(change);
    setSelectedArtifact(artifact);
  }

  function startAnalysis(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const scope = String(form.get("scope") || "Repository consistency check");
    const target = String(form.get("target") || "main");
    const manualItem: ChangeItem = {
      id: `M${changes.filter((item) => item.id.startsWith("M")).length + 1}`,
      title: scope,
      source: target,
      time: "just now",
      severity: "Processing",
      affected: 0,
      reviewState: "processing",
      confidence: "Analyzing relationships",
      relation: "may affect",
      trigger: "Manual",
      summary:
        "SpecGraph is parsing the selected scope and traversing its connected specifications, documentation, code, and tests.",
      artifacts: [],
    };
    setChanges((current) => [manualItem, ...current]);
    setAnalyzeOpen(false);
    setActiveView("inbox");
    setFilter("processing");
    setToast(`Analysis queued for ${target}`);
  }

  function showToast(message: string) {
    setToast(message);
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button
          className="brand"
          type="button"
          onClick={() => setActiveView("inbox")}
          aria-label="SpecGraph home"
        >
          <span className="brand-mark">S/G</span>
          <span>SpecGraph</span>
        </button>

        <div className="workspace">
          <span className="eyebrow">Workspace</span>
          <strong>ACME / Platform</strong>
          <span className="workspace-status">
            <i aria-hidden="true" /> All sources healthy
          </span>
        </div>

        <nav className="primary-nav" aria-label="Primary navigation">
          {navItems.map((item) => (
            <button
              type="button"
              key={item.id}
              className={activeView === item.id ? "nav-item active" : "nav-item"}
              aria-current={activeView === item.id ? "page" : undefined}
              onClick={() => setActiveView(item.id)}
            >
              <span>{item.label}</span>
              {item.id === "inbox" && <strong>{counts.all}</strong>}
            </button>
          ))}
        </nav>

        <div className="sidebar-foot">
          <div className="avatar" aria-hidden="true">
            AK
          </div>
          <div>
            <strong>Alex Kim</strong>
            <span>Reviewer</span>
          </div>
          <button
            type="button"
            className="quiet-icon"
            aria-label="Account menu"
            onClick={() => showToast("Account menu")}
          >
            ···
          </button>
        </div>
      </aside>

      <main className="main">
        {activeView === "inbox" && (
          <>
            <header className="page-header">
              <div>
                <p className="kicker">Review workspace</p>
                <h1>Change Inbox</h1>
                <p className="subtitle">
                  Changes that may need a coordinated update.
                </p>
              </div>
              <div className="header-actions">
                {searchOpen ? (
                  <label className="search-field">
                    <span className="sr-only">Search changes</span>
                    <input
                      autoFocus
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="Search changes"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        setQuery("");
                        setSearchOpen(false);
                      }}
                      aria-label="Close search"
                    >
                      ×
                    </button>
                  </label>
                ) : (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="Search changes"
                    onClick={() => setSearchOpen(true)}
                  >
                    <span aria-hidden="true">⌕</span>
                  </button>
                )}
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => setAnalyzeOpen(true)}
                >
                  Analyze now <span aria-hidden="true">＋</span>
                </button>
              </div>
            </header>

            <div className="filter-row" aria-label="Change filters">
              <button
                type="button"
                aria-pressed={filter === "all"}
                onClick={() => setFilter("all")}
              >
                All <span>{counts.all}</span>
              </button>
              <button
                type="button"
                aria-pressed={filter === "needs-review"}
                onClick={() => setFilter("needs-review")}
              >
                Needs review <span>{counts.needsReview}</span>
              </button>
              <button
                type="button"
                aria-pressed={filter === "processing"}
                onClick={() => setFilter("processing")}
              >
                Processing <span>{counts.processing}</span>
              </button>
              <p>
                Synced 2 min ago <i aria-hidden="true" />
              </p>
            </div>

            <div className="feed-head" aria-hidden="true">
              <span>No.</span>
              <span>Detected change / relationships</span>
              <span>Impact / evidence</span>
            </div>

            <section className="change-feed" aria-label="Detected changes">
              {visibleChanges.map((change) => (
                <article className="change-row" key={change.id}>
                  <div className="change-number">{change.id}</div>
                  <div className="change-body">
                    <button
                      className="change-title"
                      type="button"
                      onClick={() => {
                        setSelectedChange(change);
                        setSelectedArtifact(null);
                      }}
                    >
                      {change.title}
                    </button>
                    <p className="detected">
                      Detected in <code>{change.source}</code>
                      <span aria-hidden="true"> · </span>
                      {change.time}
                      <span className="trigger">{change.trigger}</span>
                    </p>
                    <div className="relationships">
                      <em>{change.relation}</em>
                      <span className="relation-line" aria-hidden="true">
                        <i />
                      </span>
                      <div className="artifact-links">
                        {change.artifacts.length ? (
                          change.artifacts.map((artifact) => (
                            <button
                              type="button"
                              key={`${change.id}-${artifact.name}`}
                              onClick={() => showArtifact(change, artifact)}
                            >
                              {artifact.name} <Arrow />
                            </button>
                          ))
                        ) : (
                          <span className="analyzing-copy">
                            Building relationship graph…
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="impact">
                    <span
                      className={`impact-badge ${change.severity
                        .toLowerCase()
                        .replace(" ", "-")}`}
                    >
                      {change.severity}
                    </span>
                    <span className="affected">
                      {change.affected
                        ? `${change.affected} affected`
                        : "Scanning"}
                    </span>
                    <span
                      className={
                        change.reviewState === "processing"
                          ? "evidence processing"
                          : "evidence"
                      }
                    >
                      <i aria-hidden="true" /> {change.confidence}
                    </span>
                    <button
                      type="button"
                      className="review-link"
                      onClick={() => {
                        setSelectedChange(change);
                        setSelectedArtifact(null);
                      }}
                    >
                      Review impact <Arrow />
                    </button>
                  </div>
                </article>
              ))}
              {!visibleChanges.length && (
                <div className="empty-state">
                  <span>00</span>
                  <div>
                    <h2>No matching changes</h2>
                    <p>Try another filter or clear your search.</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setQuery("");
                      setFilter("all");
                    }}
                  >
                    Clear filters
                  </button>
                </div>
              )}
            </section>
          </>
        )}

        {activeView === "runs" && (
          <section className="secondary-view">
            <header className="page-header">
              <div>
                <p className="kicker">Analysis history</p>
                <h1>Runs</h1>
                <p className="subtitle">
                  Every automatic, scheduled, and manual analysis.
                </p>
              </div>
              <button
                type="button"
                className="primary-button"
                onClick={() => setAnalyzeOpen(true)}
              >
                New analysis <span aria-hidden="true">＋</span>
              </button>
            </header>
            <div className="ledger-head run-grid">
              <span>Run</span>
              <span>Trigger</span>
              <span>Scope</span>
              <span>Findings</span>
              <span>Status</span>
            </div>
            {[
              ["RUN-142", "Webhook", "a19f2d · refunds", "4", "Needs review"],
              ["RUN-141", "Webhook", "0c81a4 · openapi", "5", "Needs review"],
              ["RUN-140", "Scheduled", "Repository", "1", "Complete"],
              ["RUN-139", "Manual", "release/2026.07", "0", "Complete"],
            ].map((run) => (
              <button
                type="button"
                className="ledger-row run-grid"
                key={run[0]}
                onClick={() => showToast(`${run[0]} details opened`)}
              >
                <strong>{run[0]}</strong>
                <span>{run[1]}</span>
                <code>{run[2]}</code>
                <span>{run[3]}</span>
                <span className="ledger-status">{run[4]}</span>
              </button>
            ))}
          </section>
        )}

        {activeView === "sources" && (
          <section className="secondary-view">
            <header className="page-header">
              <div>
                <p className="kicker">Sources of truth</p>
                <h1>Sources</h1>
                <p className="subtitle">
                  Connected systems SpecGraph reads and reconciles.
                </p>
              </div>
              <button
                type="button"
                className="primary-button"
                onClick={() => showToast("Source connection flow opened")}
              >
                Connect source <span aria-hidden="true">＋</span>
              </button>
            </header>
            <div className="ledger-head source-grid">
              <span>Source</span>
              <span>Included scope</span>
              <span>Last sync</span>
              <span>Status</span>
              <span />
            </div>
            {[
              ["GH", "GitHub", "acme/platform-api · main", "2 min ago", "Healthy"],
              [
                "CF",
                "Confluence",
                "Engineering / API Platform",
                "7 min ago",
                "Healthy",
              ],
            ].map((source) => (
              <div className="ledger-row source-grid" key={source[1]}>
                <div className="source-name">
                  <i aria-hidden="true">{source[0]}</i>
                  <strong>{source[1]}</strong>
                </div>
                <code>{source[2]}</code>
                <span>{source[3]}</span>
                <span className="healthy">
                  <i aria-hidden="true" /> {source[4]}
                </span>
                <button
                  type="button"
                  className="review-link"
                  onClick={() => showToast(`${source[1]} synchronized`)}
                >
                  Sync now <Arrow />
                </button>
              </div>
            ))}
          </section>
        )}

        {activeView === "settings" && (
          <section className="secondary-view settings-view">
            <header className="page-header">
              <div>
                <p className="kicker">Workspace controls</p>
                <h1>Settings</h1>
                <p className="subtitle">
                  Keep analysis useful, reviewable, and cost-aware.
                </p>
              </div>
              <button
                type="button"
                className="primary-button"
                onClick={() => showToast("Settings saved")}
              >
                Save changes
              </button>
            </header>
            <div className="setting-group">
              <div>
                <p className="eyebrow">Reconciliation</p>
                <h2>Nightly repository scan</h2>
                <p>
                  Recover missed events and re-check uncertain relationships.
                </p>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={nightlyScan}
                  onChange={(event) => setNightlyScan(event.target.checked)}
                />
                <span>{nightlyScan ? "On" : "Off"}</span>
              </label>
            </div>
            <div className="setting-group">
              <div>
                <p className="eyebrow">Review</p>
                <h2>Needs-review alerts</h2>
                <p>Notify reviewers when a high-impact finding is ready.</p>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={reviewAlerts}
                  onChange={(event) => setReviewAlerts(event.target.checked)}
                />
                <span>{reviewAlerts ? "On" : "Off"}</span>
              </label>
            </div>
            <div className="setting-group">
              <div>
                <p className="eyebrow">Confidence</p>
                <h2>Human confirmation threshold</h2>
                <p>
                  Inferred relationships below this score require confirmation.
                </p>
              </div>
              <label className="threshold">
                <span>80%</span>
                <input
                  type="range"
                  min="50"
                  max="100"
                  defaultValue="80"
                  aria-label="Human confirmation threshold"
                />
              </label>
            </div>
          </section>
        )}
      </main>

      {analyzeOpen && (
        <div
          className="overlay"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setAnalyzeOpen(false);
          }}
        >
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="analyze-title"
          >
            <header>
              <div>
                <p className="kicker">Manual job</p>
                <h2 id="analyze-title">Run an analysis</h2>
              </div>
              <button
                type="button"
                aria-label="Close analysis form"
                onClick={() => setAnalyzeOpen(false)}
              >
                ×
              </button>
            </header>
            <p className="modal-copy">
              Choose a scope. The run will appear in the same inbox as automatic
              changes.
            </p>
            <form onSubmit={startAnalysis}>
              <label>
                <span>Analysis type</span>
                <select name="scope" defaultValue="Repository consistency check">
                  <option>Repository consistency check</option>
                  <option>Pull request impact analysis</option>
                  <option>Single document rescan</option>
                  <option>Pre-release check</option>
                </select>
              </label>
              <label>
                <span>Branch, pull request, or path</span>
                <input
                  name="target"
                  defaultValue="main"
                  placeholder="main, #842, or docs/refunds.md"
                  required
                />
              </label>
              <div className="modal-note">
                <span>01</span>
                <p>
                  Deterministic relationships run first. AI is used only where
                  the impact is ambiguous.
                </p>
              </div>
              <footer>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setAnalyzeOpen(false)}
                >
                  Cancel
                </button>
                <button type="submit" className="primary-button">
                  Start analysis <Arrow />
                </button>
              </footer>
            </form>
          </section>
        </div>
      )}

      {selectedChange && (
        <div
          className="drawer-layer"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setSelectedChange(null);
              setSelectedArtifact(null);
            }
          }}
        >
          <aside
            className="inspector"
            role="dialog"
            aria-modal="true"
            aria-labelledby="inspector-title"
          >
            <header>
              <span className="inspector-index">{selectedChange.id}</span>
              <button
                type="button"
                aria-label="Close impact details"
                onClick={() => {
                  setSelectedChange(null);
                  setSelectedArtifact(null);
                }}
              >
                ×
              </button>
            </header>
            <p className="kicker">
              {selectedArtifact ? selectedArtifact.kind : "Impact report"}
            </p>
            <h2 id="inspector-title">
              {selectedArtifact?.name || selectedChange.title}
            </h2>
            <p className="inspector-summary">
              {selectedArtifact?.location || selectedChange.summary}
            </p>

            {selectedArtifact ? (
              <>
                <div className="excerpt">
                  <span>Relevant excerpt</span>
                  <blockquote>{selectedArtifact.excerpt}</blockquote>
                </div>
                <div className="evidence-row">
                  <span>Relationship</span>
                  <strong>{selectedChange.relation}</strong>
                </div>
                <div className="evidence-row">
                  <span>Evidence</span>
                  <strong>{selectedChange.confidence}</strong>
                </div>
                <button
                  type="button"
                  className="primary-button inspector-action"
                  onClick={() =>
                    showToast(
                      `${selectedArtifact.name} would open in ${selectedArtifact.kind}`,
                    )
                  }
                >
                  Open in {selectedArtifact.kind} <Arrow />
                </button>
              </>
            ) : (
              <>
                <div className="inspector-section-head">
                  <span>Affected resources</span>
                  <strong>{selectedChange.affected}</strong>
                </div>
                <div className="inspector-artifacts">
                  {selectedChange.artifacts.map((artifact, index) => (
                    <button
                      type="button"
                      key={artifact.name}
                      onClick={() => setSelectedArtifact(artifact)}
                    >
                      <span>{String(index + 1).padStart(2, "0")}</span>
                      <div>
                        <strong>{artifact.name}</strong>
                        <small>{artifact.kind}</small>
                      </div>
                      <Arrow />
                    </button>
                  ))}
                  {!selectedChange.artifacts.length && (
                    <p className="drawer-processing">
                      Parsing changes and evaluating candidate relationships.
                    </p>
                  )}
                </div>
                {selectedChange.reviewState !== "processing" && (
                  <footer className="review-actions">
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => {
                        setSelectedChange(null);
                        showToast("Finding marked unrelated");
                      }}
                    >
                      Mark unrelated
                    </button>
                    <button
                      type="button"
                      className="primary-button"
                      onClick={() =>
                        showToast("Review workspace opened for this finding")
                      }
                    >
                      Review changes <Arrow />
                    </button>
                  </footer>
                )}
              </>
            )}
          </aside>
        </div>
      )}

      <div className={toast ? "toast visible" : "toast"} role="status">
        <span aria-hidden="true">✓</span> {toast}
      </div>
    </div>
  );
}
