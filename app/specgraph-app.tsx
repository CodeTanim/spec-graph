"use client";

import { FormEvent, useEffect, useState } from "react";
import { httpSpecGraphApi, type SpecGraphApi } from "../lib/api-client";
import {
  emptyDashboardSnapshot,
  type AffectedArtifact,
  type ChangeFilter,
  type ChangeItem,
  type DashboardSnapshot,
  type FindingAction,
  type RunItem,
  type SourceItem,
} from "../lib/contracts/specgraph";

type View = "changes" | "runs" | "sources";

type SpecGraphAppProps = {
  api?: SpecGraphApi;
  initialData?: DashboardSnapshot;
  loadOnMount?: boolean;
};

function Arrow() {
  return <span aria-hidden="true">→</span>;
}

function statusText(change: ChangeItem) {
  if (change.status === "processing") return "Analyzing…";
  if (change.status === "checked") return "Checked";
  return `${change.affected} affected`;
}

function runResult(run: RunItem) {
  if (run.status === "queued") return "Queued";
  if (run.status === "running") return "Analyzing…";
  if (run.status === "failed") return "Failed";
  if (run.findingsCount === 0) return "No findings";
  return `${run.findingsCount} ${run.findingsCount === 1 ? "finding" : "findings"}`;
}

function providerLabel(source: SourceItem) {
  return source.provider === "github" ? "GitHub" : "Confluence";
}

function providerMonogram(source: SourceItem) {
  return source.provider === "github" ? "GH" : "CF";
}

function sourceStatus(source: SourceItem) {
  switch (source.status) {
    case "connected":
      return "Connected";
    case "syncing":
      return "Preparing";
    case "error":
      return "Needs attention";
    case "disconnected":
      return "Disconnected";
    default:
      return "Pending";
  }
}

export function relativeTime(value: string | null, now = Date.now()) {
  if (!value) return "Not checked yet";
  const timestamp = new Date(value).valueOf();
  if (Number.isNaN(timestamp)) return value;
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

export function SpecGraphApp({
  api = httpSpecGraphApi,
  initialData,
  loadOnMount = true,
}: SpecGraphAppProps) {
  const initial = initialData ?? emptyDashboardSnapshot;
  const [view, setView] = useState<View>("changes");
  const [filter, setFilter] = useState<ChangeFilter>("open");
  const [changes, setChanges] = useState(initial.changes);
  const [runs, setRuns] = useState(initial.runs.items);
  const [sources, setSources] = useState(initial.sources.items);
  const [loadingChanges, setLoadingChanges] = useState(!initialData);
  const [loadingRuns, setLoadingRuns] = useState(!initialData);
  const [loadingSources, setLoadingSources] = useState(!initialData);
  const [error, setError] = useState("");
  const [selectedChange, setSelectedChange] = useState<ChangeItem | null>(null);
  const [selectedArtifact, setSelectedArtifact] = useState<AffectedArtifact | null>(null);
  const [showEvidence, setShowEvidence] = useState(false);
  const [analyzeOpen, setAnalyzeOpen] = useState(false);
  const [savingAction, setSavingAction] = useState(false);
  const [toast, setToast] = useState("");

  useEffect(() => {
    if (!loadOnMount) return;
    let cancelled = false;

    void Promise.all([api.loadChanges("open"), api.loadRuns(), api.loadSources()])
      .then(([nextChanges, nextRuns, nextSources]) => {
        if (cancelled) return;
        setChanges(nextChanges);
        setRuns(nextRuns.items);
        setSources(nextSources.items);
        setError("");
      })
      .catch((loadError: unknown) => {
        if (cancelled) return;
        setError(
          loadError instanceof Error
            ? loadError.message
            : "SpecGraph could not load your workspace.",
        );
      })
      .finally(() => {
        if (cancelled) return;
        setLoadingChanges(false);
        setLoadingRuns(false);
        setLoadingSources(false);
      });

    return () => {
      cancelled = true;
    };
  }, [api, loadOnMount]);

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

  const openCount = changes.counts.open;
  const visibleChanges = changes.items;

  function chooseView(nextView: View) {
    setView(nextView);
    setSelectedChange(null);
    setSelectedArtifact(null);
  }

  async function chooseFilter(nextFilter: ChangeFilter) {
    if (nextFilter === filter || loadingChanges) return;
    setFilter(nextFilter);
    setLoadingChanges(true);
    try {
      setChanges(await api.loadChanges(nextFilter));
      setError("");
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "Changes could not be loaded.",
      );
    } finally {
      setLoadingChanges(false);
    }
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

  async function refreshChanges() {
    setChanges(await api.loadChanges(filter));
  }

  async function applyFindingAction(action: FindingAction) {
    if (!selectedChange || savingAction) return;
    setSavingAction(true);
    try {
      await api.updateChange(selectedChange.id, action);
      closeChange();
      await refreshChanges();
      setToast(action === "dismiss" ? "Change dismissed" : "Change resolved");
    } catch (actionError) {
      setToast(
        actionError instanceof Error
          ? actionError.message
          : "The change could not be updated.",
      );
    } finally {
      setSavingAction(false);
    }
  }

  async function startAnalysis(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const target = String(form.get("target") || "").trim();
    const requestedSourceId = String(form.get("sourceId") || "").trim();

    try {
      const result = await api.startRun({
        target,
        sourceId: requestedSourceId || sources[0]?.id,
      });
      setRuns((current) => [result.run, ...current]);
      setAnalyzeOpen(false);
      setView("runs");
      setToast(`Analysis queued for ${target}`);
    } catch (runError) {
      setToast(
        runError instanceof Error ? runError.message : "The analysis could not be started.",
      );
    }
  }

  function requestAnalysis() {
    if (!sources.length) {
      setToast("Connect a source before starting an analysis.");
      return;
    }
    setAnalyzeOpen(true);
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

        <button type="button" className="primary-action" onClick={requestAnalysis}>
          Analyze
        </button>
      </header>

      <main className="content">
        {error && (
          <div className="state-message error" role="alert">
            <strong>SpecGraph couldn’t load everything.</strong>
            <span>{error}</span>
          </div>
        )}

        {view === "changes" && (
          <>
            <section className="intro" aria-labelledby="changes-title">
              <p className="section-label">Changes</p>
              <h1 id="changes-title">
                {loadingChanges
                  ? "Checking your workspace"
                  : openCount === 0
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
                  onClick={() => void chooseFilter("open")}
                >
                  Open <span>{openCount}</span>
                </button>
                <button
                  type="button"
                  aria-pressed={filter === "all"}
                  onClick={() => void chooseFilter("all")}
                >
                  All <span>{changes.counts.total}</span>
                </button>
              </div>
              <p>
                {loadingChanges
                  ? "Checking…"
                  : changes.lastCheckedAt
                    ? `Last checked ${relativeTime(changes.lastCheckedAt)}`
                    : "Not checked yet"}
              </p>
            </div>

            <section
              className="change-list"
              aria-label="Detected changes"
              aria-busy={loadingChanges}
            >
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
                      {change.source} <i aria-hidden="true">·</i>{" "}
                      {relativeTime(change.occurredAt)}
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
              {!loadingChanges && !visibleChanges.length && (
                <div className="empty-message">
                  <strong>{filter === "open" ? "No open changes." : "No changes yet."}</strong>
                  <span>
                    {sources.length
                      ? "We’ll add one here when something needs attention."
                      : "Connect a source to start checking code and documentation."}
                  </span>
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
            <section className="simple-list" aria-label="Analysis runs" aria-busy={loadingRuns}>
              {runs.map((run) => (
                <div className="simple-row" key={run.id}>
                  <span>
                    <strong>{run.title}</strong>
                    <small>
                      {run.trigger[0].toUpperCase() + run.trigger.slice(1)}{" "}
                      <i aria-hidden="true">·</i> {relativeTime(run.createdAt)}
                    </small>
                  </span>
                  <span>{runResult(run)}</span>
                </div>
              ))}
              {!loadingRuns && !runs.length && (
                <div className="empty-message">
                  <strong>No analysis runs yet.</strong>
                  <span>Manual and automatic checks will appear here.</span>
                </div>
              )}
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
            <section
              className="simple-list"
              aria-label="Connected sources"
              aria-busy={loadingSources}
            >
              {sources.map((source) => (
                <div className="source-row" key={source.id}>
                  <span className="source-monogram" aria-hidden="true">
                    {providerMonogram(source)}
                  </span>
                  <span>
                    <strong>{providerLabel(source)}</strong>
                    <small>
                      {source.name}
                      {source.detail ? ` · ${source.detail}` : ""}
                    </small>
                  </span>
                  <span className={source.status === "error" ? "source-error" : "connected"}>
                    {sourceStatus(source)}
                  </span>
                </div>
              ))}
              {!loadingSources && !sources.length && (
                <div className="empty-message">
                  <strong>No sources connected.</strong>
                  <span>Connect GitHub first; repository documentation is included automatically.</span>
                </div>
              )}
            </section>
            <button
              type="button"
              className="text-action"
              onClick={() => setToast("GitHub and Confluence connections are the next package.")}
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
              {selectedChange.source} <span aria-hidden="true">·</span>{" "}
              {relativeTime(selectedChange.occurredAt)}
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
                      key={artifact.id}
                      aria-expanded={selectedArtifact?.id === artifact.id}
                      onClick={() =>
                        setSelectedArtifact((current) =>
                          current?.id === artifact.id ? null : artifact,
                        )
                      }
                    >
                      <span>
                        <strong>{artifact.name}</strong>
                        <small>{artifact.kind}</small>
                      </span>
                      <span aria-hidden="true">
                        {selectedArtifact?.id === artifact.id ? "−" : "+"}
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="analysis-message">
                  {selectedChange.status === "processing"
                    ? "Analysis is still running."
                    : "No affected items were found."}
                </p>
              )}

              {selectedArtifact && (
                <div className="artifact-preview">
                  <span>{selectedArtifact.location}</span>
                  <blockquote>{selectedArtifact.excerpt}</blockquote>
                  <p>{selectedArtifact.reason}</p>
                  {selectedArtifact.externalUrl && (
                    <a href={selectedArtifact.externalUrl} target="_blank" rel="noreferrer">
                      Open source <Arrow />
                    </a>
                  )}
                </div>
              )}
            </section>

            {selectedChange.status !== "processing" && selectedChange.evidence && (
              <button
                type="button"
                className="evidence-toggle"
                aria-expanded={showEvidence}
                onClick={() => setShowEvidence((current) => !current)}
              >
                How did we find these?{" "}
                <span aria-hidden="true">{showEvidence ? "−" : "+"}</span>
              </button>
            )}
            {showEvidence && <p className="evidence-copy">{selectedChange.evidence}</p>}

            {selectedChange.status === "open" && (
              <footer className="details-actions">
                <button
                  type="button"
                  className="dismiss-action"
                  disabled={savingAction}
                  onClick={() => void applyFindingAction("dismiss")}
                >
                  Dismiss
                </button>
                <button
                  type="button"
                  className="primary-action wide"
                  disabled={savingAction}
                  onClick={() => void applyFindingAction("resolve")}
                >
                  Mark resolved <Arrow />
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
              <button
                type="button"
                onClick={() => setAnalyzeOpen(false)}
                aria-label="Close analysis form"
              >
                ×
              </button>
            </header>
            <p>Enter a branch, pull request, file, or documentation page.</p>
            <form onSubmit={(event) => void startAnalysis(event)}>
              {sources.length > 1 && (
                <>
                  <label htmlFor="analysis-source">Source</label>
                  <select id="analysis-source" name="sourceId" defaultValue={sources[0]?.id}>
                    {sources.map((source) => (
                      <option key={source.id} value={source.id}>
                        {providerLabel(source)} — {source.name}
                      </option>
                    ))}
                  </select>
                </>
              )}
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
                <button
                  type="button"
                  className="dismiss-action"
                  onClick={() => setAnalyzeOpen(false)}
                >
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
