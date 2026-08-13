"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type View = "changes" | "runs" | "sources";
type Filter = "open" | "all";
type ChangeStatus = "open" | "processing" | "checked";

type Artifact = {
  name: string;
  kind: "Confluence" | "OpenAPI" | "Test" | "Markdown" | "Code";
  location: string;
  excerpt: string;
};

export type ChangeItem = {
  id: string;
  title: string;
  source: string;
  time: string;
  status: ChangeStatus;
  affected: number;
  summary: string;
  evidence: string;
  artifacts: Artifact[];
};

const initialChanges: ChangeItem[] = [
  {
    id: "refund-window",
    title: "Refund validation window changed",
    source: "src/refunds/policy.ts",
    time: "12 min ago",
    status: "open",
    affected: 4,
    summary:
      "The refund window changed from 30 to 60 days. Four connected resources still describe or test the old behavior.",
    evidence: "The code and every listed resource refer to the same refund-window rule.",
    artifacts: [
      {
        name: "Customer Refund Guide",
        kind: "Confluence",
        location: "Customer Operations / Refunds / Eligibility",
        excerpt: "Refunds are available within 30 days of the original charge.",
      },
      {
        name: "openapi.yaml",
        kind: "OpenAPI",
        location: "api/openapi.yaml / RefundEligibility",
        excerpt: "maximumWindowDays: 30",
      },
      {
        name: "refund-window.test.ts",
        kind: "Test",
        location: "tests/refunds/refund-window.test.ts / line 42",
        excerpt: "expect(isEligible(charge, 31)).toBe(false)",
      },
      {
        name: "Mobile integration guide",
        kind: "Markdown",
        location: "docs/mobile/refunds.md / Eligibility",
        excerpt: "Requests older than 30 days return REFUND_WINDOW_EXPIRED.",
      },
    ],
  },
  {
    id: "refund-reason",
    title: "Reason is now required for refund requests",
    source: "api/openapi.yaml",
    time: "34 min ago",
    status: "open",
    affected: 5,
    summary:
      "The API contract now requires a reason. Request examples, client validation, and three tests do not include it yet.",
    evidence: "The affected resources create the same RefundRequest object defined by this schema.",
    artifacts: [
      {
        name: "Refund SDK",
        kind: "Code",
        location: "packages/sdk/src/refunds.ts / createRefund",
        excerpt: "createRefund({ transactionId })",
      },
      {
        name: "API request guide",
        kind: "Markdown",
        location: "docs/api/refunds.md / Request body",
        excerpt: '{ "transactionId": "txn_123" }',
      },
      {
        name: "Refund request tests",
        kind: "Test",
        location: "tests/refunds/",
        excerpt: "Three fixtures construct RefundRequest without a reason.",
      },
    ],
  },
  {
    id: "payout-schema",
    title: "Payout response schema expanded",
    source: "api/openapi.yaml",
    time: "yesterday",
    status: "open",
    affected: 2,
    summary:
      "The response now includes settlementStatus. Two examples still show the previous response shape.",
    evidence: "Both resources contain examples of the changed PayoutResponse schema.",
    artifacts: [
      {
        name: "Payout API guide",
        kind: "Markdown",
        location: "docs/api/payouts.md / Response",
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
    id: "webhook-retry",
    title: "Webhook retry behavior adjusted",
    source: "worker/retry.ts",
    time: "2h ago",
    status: "processing",
    affected: 0,
    summary: "SpecGraph is checking which resources describe the retry policy.",
    evidence: "Analysis is still running.",
    artifacts: [],
  },
  {
    id: "auth-wording",
    title: "Authentication guide wording updated",
    source: "Confluence / Authentication",
    time: "yesterday",
    status: "checked",
    affected: 1,
    summary: "A documentation clarification was reviewed against the repository README.",
    evidence: "The README and Confluence page describe the same authentication flow.",
    artifacts: [
      {
        name: "README / Authentication",
        kind: "Markdown",
        location: "README.md / Authentication",
        excerpt: "Use a workspace API token to authenticate every request.",
      },
    ],
  },
  {
    id: "runbook-owner",
    title: "Settlement runbook owner changed",
    source: "Confluence / Settlement Operations",
    time: "2 days ago",
    status: "checked",
    affected: 1,
    summary: "The runbook owner changed from Payments Core to Money Movement.",
    evidence: "The CODEOWNERS entry names the previous team.",
    artifacts: [
      {
        name: "CODEOWNERS",
        kind: "Code",
        location: ".github/CODEOWNERS / line 18",
        excerpt: "/settlement/ @acme/payments-core",
      },
    ],
  },
];

const activity = [
  ["Refund validation window changed", "GitHub", "12 min ago", "4 findings"],
  ["Refund request schema changed", "GitHub", "34 min ago", "5 findings"],
  ["Nightly consistency check", "Scheduled", "2h ago", "1 finding"],
  ["Release branch check", "Manual", "yesterday", "No findings"],
];

function Arrow() {
  return <span aria-hidden="true">→</span>;
}

function statusText(change: ChangeItem) {
  if (change.status === "processing") return "Analyzing…";
  if (change.status === "checked") return "Checked";
  return `${change.affected} affected`;
}

export function SpecGraphApp() {
  const [view, setView] = useState<View>("changes");
  const [filter, setFilter] = useState<Filter>("open");
  const [changes, setChanges] = useState<ChangeItem[]>(initialChanges);
  const [selectedChange, setSelectedChange] = useState<ChangeItem | null>(null);
  const [selectedArtifact, setSelectedArtifact] = useState<Artifact | null>(null);
  const [showEvidence, setShowEvidence] = useState(false);
  const [analyzeOpen, setAnalyzeOpen] = useState(false);
  const [toast, setToast] = useState("");

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setAnalyzeOpen(false);
      setSelectedChange(null);
      setSelectedArtifact(null);
      setShowEvidence(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const openCount = useMemo(
    () => changes.filter((change) => change.status === "open").length,
    [changes],
  );

  const visibleChanges = useMemo(
    () =>
      filter === "open"
        ? changes.filter((change) => change.status === "open")
        : changes,
    [changes, filter],
  );

  function chooseView(nextView: View) {
    setView(nextView);
    setSelectedChange(null);
    setSelectedArtifact(null);
  }

  function openChange(change: ChangeItem) {
    setSelectedChange(change);
    setSelectedArtifact(null);
    setShowEvidence(false);
  }

  function closeChange() {
    setSelectedChange(null);
    setSelectedArtifact(null);
    setShowEvidence(false);
  }

  function startAnalysis(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const target = String(form.get("target") || "main").trim();
    const newItem: ChangeItem = {
      id: `manual-${Date.now()}`,
      title: `Checking ${target}`,
      source: target,
      time: "just now",
      status: "processing",
      affected: 0,
      summary: "SpecGraph is checking this target for connected changes.",
      evidence: "Analysis is still running.",
      artifacts: [],
    };
    setChanges((current) => [newItem, ...current]);
    setAnalyzeOpen(false);
    setView("changes");
    setFilter("all");
    setToast(`Analysis started for ${target}`);
  }

  return (
    <div className="site-shell">
      <header className="topbar">
        <button
          type="button"
          className="wordmark"
          onClick={() => chooseView("changes")}
          aria-label="SpecGraph home"
        >
          <span aria-hidden="true">S</span>
          SpecGraph
        </button>

        <nav aria-label="Main navigation">
          {(["changes", "runs", "sources"] as View[]).map((item) => (
            <button
              type="button"
              key={item}
              onClick={() => chooseView(item)}
              aria-current={view === item ? "page" : undefined}
            >
              {item[0].toUpperCase() + item.slice(1)}
            </button>
          ))}
        </nav>

        <button
          type="button"
          className="primary-action"
          onClick={() => setAnalyzeOpen(true)}
        >
          Analyze
        </button>
      </header>

      <main className="content">
        {view === "changes" && (
          <>
            <section className="intro" aria-labelledby="changes-title">
              <p className="section-label">Changes</p>
              <h1 id="changes-title">
                {openCount === 0
                  ? "Everything is up to date"
                  : `${openCount} ${openCount === 1 ? "change needs" : "changes need"} your attention`}
              </h1>
              <p>
                We watch your connected docs and code. When something changes,
                we show what else may need updating.
              </p>
            </section>

            <div className="list-toolbar" aria-label="Change filters">
              <div>
                <button
                  type="button"
                  aria-pressed={filter === "open"}
                  onClick={() => setFilter("open")}
                >
                  Open <span>{openCount}</span>
                </button>
                <button
                  type="button"
                  aria-pressed={filter === "all"}
                  onClick={() => setFilter("all")}
                >
                  All <span>{changes.length}</span>
                </button>
              </div>
              <p>Last checked 2 min ago</p>
            </div>

            <section className="change-list" aria-label="Detected changes">
              {visibleChanges.map((change) => (
                <button
                  type="button"
                  className="change-item"
                  key={change.id}
                  onClick={() => openChange(change)}
                >
                  <span className="change-copy">
                    <strong>{change.title}</strong>
                    <small>
                      {change.source} <i aria-hidden="true">·</i> {change.time}
                    </small>
                  </span>
                  <span
                    className={
                      change.status === "processing"
                        ? "change-result processing"
                        : "change-result"
                    }
                  >
                    {statusText(change)} <Arrow />
                  </span>
                </button>
              ))}
              {!visibleChanges.length && (
                <div className="empty-message">
                  <strong>No open changes.</strong>
                  <span>We’ll add one here when something needs attention.</span>
                </div>
              )}
            </section>
          </>
        )}

        {view === "runs" && (
          <>
            <section className="intro compact" aria-labelledby="runs-title">
              <p className="section-label">Runs</p>
              <h1 id="runs-title">Recent activity</h1>
              <p>Automatic and manual checks appear here.</p>
            </section>
            <section className="simple-list" aria-label="Analysis runs">
              {activity.map(([title, trigger, time, result]) => (
                <div className="simple-row" key={`${title}-${time}`}>
                  <span>
                    <strong>{title}</strong>
                    <small>
                      {trigger} <i aria-hidden="true">·</i> {time}
                    </small>
                  </span>
                  <span>{result}</span>
                </div>
              ))}
            </section>
          </>
        )}

        {view === "sources" && (
          <>
            <section className="intro compact" aria-labelledby="sources-title">
              <p className="section-label">Sources</p>
              <h1 id="sources-title">Connected sources</h1>
              <p>SpecGraph only watches the sources you connect.</p>
            </section>
            <section className="simple-list" aria-label="Connected sources">
              <div className="source-row">
                <span className="source-monogram" aria-hidden="true">GH</span>
                <span>
                  <strong>GitHub</strong>
                  <small>acme/platform-api · main</small>
                </span>
                <span className="connected">Connected</span>
              </div>
              <div className="source-row">
                <span className="source-monogram" aria-hidden="true">CF</span>
                <span>
                  <strong>Confluence</strong>
                  <small>Engineering / API Platform</small>
                </span>
                <span className="connected">Connected</span>
              </div>
            </section>
            <button
              type="button"
              className="text-action"
              onClick={() => setToast("Source connection flow opened")}
            >
              + Add a source
            </button>
          </>
        )}
      </main>

      {selectedChange && (
        <div
          className="scrim"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeChange();
          }}
        >
          <aside
            className="details-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="change-details-title"
          >
            <header>
              <span>Change details</span>
              <button type="button" onClick={closeChange} aria-label="Close change details">
                ×
              </button>
            </header>

            <h2 id="change-details-title">{selectedChange.title}</h2>
            <p className="change-source">
              {selectedChange.source} <span aria-hidden="true">·</span> {selectedChange.time}
            </p>

            <section className="details-section">
              <h3>What changed</h3>
              <p>{selectedChange.summary}</p>
            </section>

            <section className="details-section affected-section">
              <h3>
                What may need updating
                {selectedChange.affected > 0 && <span>{selectedChange.affected}</span>}
              </h3>
              {selectedChange.artifacts.length ? (
                <div className="artifact-list">
                  {selectedChange.artifacts.map((artifact) => (
                    <button
                      type="button"
                      key={artifact.name}
                      aria-expanded={selectedArtifact?.name === artifact.name}
                      onClick={() =>
                        setSelectedArtifact((current) =>
                          current?.name === artifact.name ? null : artifact,
                        )
                      }
                    >
                      <span>
                        <strong>{artifact.name}</strong>
                        <small>{artifact.kind}</small>
                      </span>
                      <span aria-hidden="true">
                        {selectedArtifact?.name === artifact.name ? "−" : "+"}
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="analysis-message">Analysis is still running.</p>
              )}

              {selectedArtifact && (
                <div className="artifact-preview">
                  <span>{selectedArtifact.location}</span>
                  <blockquote>{selectedArtifact.excerpt}</blockquote>
                  <button
                    type="button"
                    onClick={() =>
                      setToast(`${selectedArtifact.name} would open in ${selectedArtifact.kind}`)
                    }
                  >
                    Open source <Arrow />
                  </button>
                </div>
              )}
            </section>

            {selectedChange.status !== "processing" && (
              <button
                type="button"
                className="evidence-toggle"
                aria-expanded={showEvidence}
                onClick={() => setShowEvidence((current) => !current)}
              >
                How did we find these? <span aria-hidden="true">{showEvidence ? "−" : "+"}</span>
              </button>
            )}
            {showEvidence && <p className="evidence-copy">{selectedChange.evidence}</p>}

            {selectedChange.status === "open" && (
              <footer className="details-actions">
                <button
                  type="button"
                  className="dismiss-action"
                  onClick={() => {
                    closeChange();
                    setToast("Change dismissed");
                  }}
                >
                  Dismiss
                </button>
                <button
                  type="button"
                  className="primary-action wide"
                  onClick={() => setToast("Review opened")}
                >
                  Review suggestions <Arrow />
                </button>
              </footer>
            )}
          </aside>
        </div>
      )}

      {analyzeOpen && (
        <div
          className="scrim modal-scrim"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setAnalyzeOpen(false);
          }}
        >
          <section
            className="analyze-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="analyze-title"
          >
            <header>
              <h2 id="analyze-title">Analyze now</h2>
              <button type="button" onClick={() => setAnalyzeOpen(false)} aria-label="Close analysis form">
                ×
              </button>
            </header>
            <p>Enter a branch, pull request, or file you want SpecGraph to check.</p>
            <form onSubmit={startAnalysis}>
              <label htmlFor="analysis-target">What should we check?</label>
              <input
                id="analysis-target"
                name="target"
                defaultValue="main"
                placeholder="main, #842, or docs/refunds.md"
                required
                autoFocus
              />
              <footer>
                <button type="button" className="dismiss-action" onClick={() => setAnalyzeOpen(false)}>
                  Cancel
                </button>
                <button type="submit" className="primary-action wide">
                  Run analysis
                </button>
              </footer>
            </form>
          </section>
        </div>
      )}

      <div className={toast ? "toast visible" : "toast"} role="status">
        {toast}
      </div>
    </div>
  );
}

export default SpecGraphApp;
