"use client";

import { FormEvent, useEffect, useState } from "react";
import { httpSpecGraphApi, type SpecGraphApi } from "../lib/api-client";
import {
  emptyDashboardSnapshot,
  type AffectedArtifact,
  type ChangeFilter,
  type ChangeItem,
  type ConfluenceSpaceCandidate,
  type DashboardSnapshot,
  type FindingAction,
  type GitHubRepositoryCandidate,
  type RunItem,
  type SourceItem,
  type SourceGroup,
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

function repositoryName(source: SourceItem) {
  return source.name.split("/").filter(Boolean).at(-1) || source.name;
}

function repositoryOwner(source: SourceItem) {
  return source.name.split("/").filter(Boolean).slice(0, -1).join("/");
}

function indexedFiles(count: number) {
  return `${count} indexed ${count === 1 ? "file" : "files"}`;
}

function indexedPages(count: number) {
  return `${count} indexed ${count === 1 ? "page" : "pages"}`;
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
  const [sourceGroups, setSourceGroups] = useState<SourceGroup[]>(initial.sources.groups);
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
  const [githubConfigured, setGitHubConfigured] = useState<boolean | null>(null);
  const [confluenceConfigured, setConfluenceConfigured] = useState<boolean | null>(null);
  const [githubSessionState, setGitHubSessionState] = useState("");
  const [githubRepositories, setGitHubRepositories] = useState<
    GitHubRepositoryCandidate[]
  >([]);
  const [selectedRepositoryId, setSelectedRepositoryId] = useState("");
  const [githubBranch, setGitHubBranch] = useState("");
  const [githubDocumentationSourceId, setGitHubDocumentationSourceId] = useState("");
  const [confluenceSessionState, setConfluenceSessionState] = useState("");
  const [confluenceSpaces, setConfluenceSpaces] = useState<ConfluenceSpaceCandidate[]>([]);
  const [selectedConfluenceSpaceId, setSelectedConfluenceSpaceId] = useState("");
  const [confluenceRepositorySourceId, setConfluenceRepositorySourceId] = useState("");
  const [confluenceSetupLoading, setConfluenceSetupLoading] = useState(false);
  const [addSourceOpen, setAddSourceOpen] = useState(false);
  const [addSourceRepositoryId, setAddSourceRepositoryId] = useState("");
  const [githubSetupLoading, setGitHubSetupLoading] = useState(false);
  const [syncingSourceId, setSyncingSourceId] = useState("");
  const [sourcePendingRemoval, setSourcePendingRemoval] = useState<SourceItem | null>(null);
  const [removingSourceId, setRemovingSourceId] = useState("");

  useEffect(() => {
    if (!loadOnMount) return;
    let cancelled = false;

    void Promise.all([api.loadChanges("open"), api.loadRuns(), api.loadSources()])
      .then(([nextChanges, nextRuns, nextSources]) => {
        if (cancelled) return;
        setChanges(nextChanges);
        setRuns(nextRuns.items);
        setSources(nextSources.items);
        setSourceGroups(nextSources.groups);
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
    if (!loadOnMount) return;
    let cancelled = false;
    void Promise.all([api.loadGitHubStatus(), api.loadConfluenceStatus()])
      .then(([github, confluence]) => {
        if (cancelled) return;
        setGitHubConfigured(github.configured);
        setConfluenceConfigured(confluence.configured);
      })
      .catch(() => {
        if (cancelled) return;
        setGitHubConfigured(false);
        setConfluenceConfigured(false);
      });

    const parameters = new URLSearchParams(window.location.search);
    const githubError = parameters.get("github_error");
    const sessionState = parameters.get("github_session");
    const confluenceError = parameters.get("confluence_error");
    const confluenceSession = parameters.get("confluence_session");
    window.queueMicrotask(() => {
      if (cancelled) return;
      if (githubError || confluenceError) {
        setToast(githubError || confluenceError || "A source could not be connected.");
        window.history.replaceState({}, "", window.location.pathname);
      } else if (sessionState) {
        setView("sources");
        setGitHubSetupLoading(true);
        void api
          .loadGitHubConnectionSession(sessionState)
          .then((session) => {
            if (cancelled) return;
            setGitHubSessionState(sessionState);
            setGitHubDocumentationSourceId(session.documentationSourceId || "");
            setGitHubRepositories(session.items);
            const first = session.items[0];
            setSelectedRepositoryId(first?.id || "");
            setGitHubBranch(first?.defaultBranch || "main");
          })
          .catch((sessionError: unknown) => {
            if (cancelled) return;
            setToast(
              sessionError instanceof Error
                ? sessionError.message
                : "GitHub repositories could not be loaded.",
            );
          })
          .finally(() => {
            if (!cancelled) setGitHubSetupLoading(false);
          });
      } else if (confluenceSession) {
        setView("sources");
        setConfluenceSetupLoading(true);
        void api
          .loadConfluenceConnectionSession(confluenceSession)
          .then((session) => {
            if (cancelled) return;
            setConfluenceSessionState(confluenceSession);
            setConfluenceSpaces(session.items);
            setSelectedConfluenceSpaceId(session.items[0]?.id || "");
            setConfluenceRepositorySourceId(session.repositorySourceId || "");
          })
          .catch((sessionError: unknown) => {
            if (cancelled) return;
            setToast(
              sessionError instanceof Error
                ? sessionError.message
                : "Confluence spaces could not be loaded.",
            );
          })
          .finally(() => {
            if (!cancelled) setConfluenceSetupLoading(false);
          });
      }
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
      setAddSourceOpen(false);
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

  async function refreshSources() {
    const next = await api.loadSources();
    setSources(next.items);
    setSourceGroups(next.groups);
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
      setToast(
        result.run.status === "failed"
          ? result.run.errorMessage || "Analysis failed."
          : result.run.status === "queued" || result.run.status === "running"
            ? `Analysis queued for ${target}`
            : `Analysis complete for ${target}`,
      );
    } catch (runError) {
      setToast(
        runError instanceof Error ? runError.message : "The analysis could not be started.",
      );
    }
  }

  async function finishGitHubConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!githubSessionState || !selectedRepositoryId || !githubBranch.trim()) return;
    setGitHubSetupLoading(true);
    try {
      const result = await api.connectGitHubSource({
        sessionState: githubSessionState,
        repositoryId: selectedRepositoryId,
        branch: githubBranch.trim(),
        documentationSourceId: githubDocumentationSourceId || undefined,
      });
      await refreshSources();
      setGitHubSessionState("");
      setGitHubRepositories([]);
      window.history.replaceState({}, "", window.location.pathname);
      setToast(
        result.associationAlreadyTracked
          ? `That repository and documentation are already being tracked together`
          : result.alreadyTracked
            ? `${result.source.name} was already connected`
            : `${result.source.name} connected · ${result.source.artifactCount} files indexed`,
      );
    } catch (connectionError) {
      setToast(
        connectionError instanceof Error
          ? connectionError.message
          : "The repository could not be connected.",
      );
    } finally {
      setGitHubSetupLoading(false);
    }
  }

  async function finishConfluenceConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!confluenceSessionState || !selectedConfluenceSpaceId) return;
    setConfluenceSetupLoading(true);
    try {
      const result = await api.connectConfluenceSource({
        sessionState: confluenceSessionState,
        spaceId: selectedConfluenceSpaceId,
        repositorySourceId: confluenceRepositorySourceId || undefined,
      });
      await refreshSources();
      setConfluenceSessionState("");
      setConfluenceSpaces([]);
      window.history.replaceState({}, "", window.location.pathname);
      setToast(
        result.associationAlreadyTracked && result.repositoryName
          ? `Already tracked with ${result.repositoryName.split("/").at(-1) || result.repositoryName}`
          : result.alreadyTracked
            ? `${result.source.name} was already connected`
            : `${result.source.name} connected · ${result.source.artifactCount} pages indexed`,
      );
    } catch (connectionError) {
      setToast(
        connectionError instanceof Error
          ? connectionError.message
          : "The Confluence space could not be connected.",
      );
    } finally {
      setConfluenceSetupLoading(false);
    }
  }

  async function syncSource(sourceId: string) {
    if (syncingSourceId) return;
    setSyncingSourceId(sourceId);
    try {
      const result = await api.syncSource(sourceId);
      await refreshSources();
      setToast(`${result.source.name} is up to date`);
    } catch (syncError) {
      setToast(syncError instanceof Error ? syncError.message : "The source could not be synced.");
    } finally {
      setSyncingSourceId("");
    }
  }

  async function removeConnectedSource() {
    if (!sourcePendingRemoval || removingSourceId) return;
    setRemovingSourceId(sourcePendingRemoval.id);
    try {
      await api.removeSource(sourcePendingRemoval.id);
      const removedName = sourcePendingRemoval.name;
      await refreshSources();
      setSourcePendingRemoval(null);
      setToast(`${removedName} is no longer being watched`);
    } catch (removeError) {
      setToast(
        removeError instanceof Error
          ? removeError.message
          : "The source could not be removed.",
      );
    } finally {
      setRemovingSourceId("");
    }
  }

  function openAddSource(repositorySourceId = "") {
    setAddSourceRepositoryId(repositorySourceId);
    setAddSourceOpen(true);
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
              {sourceGroups.map((group, groupIndex) => (
                <div className="source-group" key={group.repository?.id || group.documentation[0]?.id || groupIndex}>
                  {group.repository && (
                    <div className="source-row">
                      <span className="source-monogram" aria-hidden="true">GH</span>
                      <div className="source-copy">
                        <div className="source-title">
                          <strong>{repositoryName(group.repository)}</strong>
                          {group.repository.detail && <span>{group.repository.detail}</span>}
                        </div>
                        <small>GitHub · {repositoryOwner(group.repository)}</small>
                        <div className="source-contents" aria-label={`Indexed contents for ${repositoryName(group.repository)}`}>
                          <span><span aria-hidden="true">├──</span> Source code — {indexedFiles(group.repository.codeArtifactCount)}</span>
                          <span><span aria-hidden="true">└──</span> Repository documentation — {indexedFiles(group.repository.documentationArtifactCount)}</span>
                        </div>
                        <button type="button" className="source-inline-action" onClick={() => openAddSource(group.repository?.id)}>
                          + Add documentation
                        </button>
                      </div>
                      <span className="source-row-actions">
                        <span className={group.repository.status === "error" ? "source-error" : "connected"}>{sourceStatus(group.repository)}</span>
                        <button type="button" className="source-sync" disabled={Boolean(syncingSourceId)} onClick={() => void syncSource(group.repository!.id)}>
                          {syncingSourceId === group.repository.id ? "Syncing…" : "Sync"}
                        </button>
                        <button type="button" className="source-remove" disabled={Boolean(syncingSourceId || removingSourceId)} aria-label={`Remove ${repositoryName(group.repository)}`} onClick={() => setSourcePendingRemoval(group.repository)}>
                          Remove
                        </button>
                      </span>
                    </div>
                  )}
                  {group.documentation.map((source) => (
                    <div className={group.repository ? "source-row documentation-row" : "source-row"} key={source.id}>
                      <span className="source-monogram" aria-hidden="true">CF</span>
                      <div className="source-copy">
                        <div className="source-title"><strong>Confluence — {source.name}</strong></div>
                        <small>{source.detail}</small>
                        <div className="source-contents"><span>{indexedPages(source.documentationArtifactCount)}</span></div>
                        {!group.repository && (
                          <a className="source-inline-action" href={`/api/github/connect?documentation_source_id=${encodeURIComponent(source.id)}`}>
                            + Connect repository
                          </a>
                        )}
                      </div>
                      <span className="source-row-actions">
                        <span className={source.status === "error" ? "source-error" : "connected"}>{sourceStatus(source)}</span>
                        <button type="button" className="source-sync" disabled={Boolean(syncingSourceId)} onClick={() => void syncSource(source.id)}>
                          {syncingSourceId === source.id ? "Syncing…" : "Sync"}
                        </button>
                        <button type="button" className="source-remove" disabled={Boolean(syncingSourceId || removingSourceId)} aria-label={`Remove ${source.name}`} onClick={() => setSourcePendingRemoval(source)}>
                          Remove
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              ))}
              {!loadingSources && !sources.length && (
                <div className="empty-message">
                  <strong>No sources connected.</strong>
                  <span>Add a repository or documentation source to start tracking them.</span>
                </div>
              )}
            </section>
            {githubRepositories.length > 0 ? (
              <form className="github-setup" onSubmit={(event) => void finishGitHubConnection(event)}>
                <div>
                  <strong>Choose a repository</strong>
                  <span>Repository documentation is included automatically.</span>
                </div>
                <label htmlFor="github-repository">Repository</label>
                <select
                  id="github-repository"
                  value={selectedRepositoryId}
                  onChange={(event) => {
                    const repository = githubRepositories.find(
                      (item) => item.id === event.target.value,
                    );
                    setSelectedRepositoryId(event.target.value);
                    setGitHubBranch(repository?.defaultBranch || "main");
                  }}
                >
                  {githubRepositories.map((repository) => (
                    <option key={repository.id} value={repository.id}>
                      {repository.fullName}
                    </option>
                  ))}
                </select>
                <label htmlFor="github-branch">Branch to watch</label>
                <input
                  id="github-branch"
                  value={githubBranch}
                  onChange={(event) => setGitHubBranch(event.target.value)}
                  required
                />
                <button type="submit" className="primary-action wide" disabled={githubSetupLoading}>
                  {githubSetupLoading ? "Preparing repository…" : "Connect repository"}
                </button>
              </form>
            ) : confluenceSpaces.length > 0 ? (
              <form className="github-setup" onSubmit={(event) => void finishConfluenceConnection(event)}>
                <div>
                  <strong>Choose documentation</strong>
                  <span>Select the Confluence space SpecGraph should watch.</span>
                </div>
                <label htmlFor="confluence-space">Space</label>
                <select id="confluence-space" value={selectedConfluenceSpaceId} onChange={(event) => setSelectedConfluenceSpaceId(event.target.value)}>
                  {confluenceSpaces.map((space) => <option key={`${space.cloudId}:${space.id}`} value={space.id}>{space.siteName} / {space.name}</option>)}
                </select>
                <button type="submit" className="primary-action wide" disabled={confluenceSetupLoading}>
                  {confluenceSetupLoading ? "Preparing documentation…" : "Connect documentation"}
                </button>
              </form>
            ) : githubSetupLoading || confluenceSetupLoading ? (
              <p className="connection-note" role="status">
                {confluenceSetupLoading ? "Loading Confluence spaces…" : "Loading GitHub repositories…"}
              </p>
            ) : (
              <button type="button" className="text-action" onClick={() => openAddSource()}>
                + Add source
              </button>
            )}
          </>
        )}
      </main>

      {addSourceOpen && (
        <div
          className="scrim modal-scrim"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setAddSourceOpen(false);
          }}
        >
          <section className="analyze-modal source-picker" role="dialog" aria-modal="true" aria-labelledby="add-source-title">
            <header>
              <h2 id="add-source-title">
                {addSourceRepositoryId ? "Add documentation" : "Add source"}
              </h2>
              <button type="button" onClick={() => setAddSourceOpen(false)} aria-label="Close source chooser">×</button>
            </header>
            <p>
              {addSourceRepositoryId
                ? "Choose documentation to track with this repository."
                : "Choose what SpecGraph should watch."}
            </p>
            <div className="source-provider-options">
              {!addSourceRepositoryId && (
                githubConfigured === false ? (
                  <span className="provider-option disabled"><strong>GitHub repository</strong><small>Needs one-time configuration</small></span>
                ) : (
                  <a className="provider-option" href="/api/github/connect"><strong>GitHub repository</strong><small>Code and repository documentation</small><Arrow /></a>
                )
              )}
              {confluenceConfigured === false ? (
                <span className="provider-option disabled"><strong>Confluence documentation</strong><small>Available after hosting and OAuth setup</small></span>
              ) : (
                <a
                  className="provider-option"
                  href={addSourceRepositoryId
                    ? `/api/confluence/connect?repository_source_id=${encodeURIComponent(addSourceRepositoryId)}`
                    : "/api/confluence/connect"}
                >
                  <strong>Confluence documentation</strong><small>Site and space</small><Arrow />
                </a>
              )}
              <span className="provider-option disabled" aria-disabled="true">
                <strong>Notion documentation</strong>
                <small>Connection coming next</small>
              </span>
            </div>
          </section>
        </div>
      )}

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

      {sourcePendingRemoval && (
        <div
          className="scrim modal-scrim"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !removingSourceId) {
              setSourcePendingRemoval(null);
            }
          }}
        >
          <section
            className="analyze-modal remove-source-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="remove-source-title"
          >
            <header>
              <h2 id="remove-source-title">
                Stop watching{" "}
                {sourcePendingRemoval.provider === "github"
                  ? repositoryName(sourcePendingRemoval)
                  : sourcePendingRemoval.name}
                ?
              </h2>
              <button
                type="button"
                disabled={Boolean(removingSourceId)}
                onClick={() => setSourcePendingRemoval(null)}
                aria-label="Close remove source confirmation"
              >
                ×
              </button>
            </header>
            <p>
              Its current index and relationships will be removed. Existing findings and run
              history will remain available.
            </p>
            <footer>
              <button
                type="button"
                className="dismiss-action"
                disabled={Boolean(removingSourceId)}
                onClick={() => setSourcePendingRemoval(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="primary-action wide"
                disabled={Boolean(removingSourceId)}
                onClick={() => void removeConnectedSource()}
              >
                {removingSourceId ? "Removing…" : "Remove source"}
              </button>
            </footer>
          </section>
        </div>
      )}

      <div className={toast ? "toast visible" : "toast"} role="status">
        {toast}
      </div>
    </div>
  );
}
