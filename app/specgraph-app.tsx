"use client";

import {
  FormEvent,
  Fragment,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
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
  accountAction?: ReactNode;
  initialData?: DashboardSnapshot;
  loadOnMount?: boolean;
};

type SourceConnectionContext = {
  groupId: string;
};

type AnalysisProgress = {
  target: string;
  runId: string | null;
  error: string;
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
  if (run.status === "running") return `Analyzing… ${run.progress}%`;
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

function sourceFreshness(source: SourceItem) {
  if (source.status === "pending" || source.status === "syncing") {
    return "Indexing now";
  }
  if (source.status === "error") return "The last check failed";
  if (source.status === "disconnected") return "Reconnect to continue";
  return source.lastSyncedAt
    ? `Last checked ${relativeTime(source.lastSyncedAt)}`
    : "Not checked yet";
}

function relationshipSignal(artifact: AffectedArtifact): string {
  const labels: Record<AffectedArtifact["provenance"], string> = {
    USER_DEFINED: "User-confirmed relationship",
    EXPLICIT_LINK: "Direct link",
    EXACT_PATH: "Exact path reference",
    IMPORT: "Code import",
    TEST_NAMING: "Test mapping",
    OPENAPI_ENTITY: "API contract",
    EXACT_IDENTIFIER: "Exact identifier",
    SHARED_ENTITY: "Shared entities",
    SEMANTIC: "Semantic match",
    CO_CHANGE: "Change history",
    STRUCTURAL: "Defined in changed file",
    LEGACY: "Verified relationship",
  };
  return `${labels[artifact.provenance]} · ${Math.round(artifact.confidence * 100)}% confidence`;
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
  accountAction,
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
  const [showChangedArtifacts, setShowChangedArtifacts] = useState(false);
  const [analyzeOpen, setAnalyzeOpen] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState<AnalysisProgress | null>(null);
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
  const [githubSourceGroupId, setGitHubSourceGroupId] = useState("");
  const [confluenceSessionState, setConfluenceSessionState] = useState("");
  const [confluenceSpaces, setConfluenceSpaces] = useState<ConfluenceSpaceCandidate[]>([]);
  const [selectedConfluenceSpaceId, setSelectedConfluenceSpaceId] = useState("");
  const [confluenceSourceGroupId, setConfluenceSourceGroupId] = useState("");
  const [confluenceSetupLoading, setConfluenceSetupLoading] = useState(false);
  const [addSourceOpen, setAddSourceOpen] = useState(false);
  const [sourceSetupOpen, setSourceSetupOpen] = useState(false);
  const [sourceSetupError, setSourceSetupError] = useState("");
  const [sourcePickerNotice, setSourcePickerNotice] = useState("");
  const [sourceConnectionContext, setSourceConnectionContext] =
    useState<SourceConnectionContext | null>(null);
  const [githubSetupLoading, setGitHubSetupLoading] = useState(false);
  const [syncingSourceId, setSyncingSourceId] = useState("");
  const [sourcePendingRemoval, setSourcePendingRemoval] = useState<SourceItem | null>(null);
  const [removingSourceId, setRemovingSourceId] = useState("");
  const lastWorkspaceRefreshAt = useRef(Date.now());

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
        setSourceSetupOpen(true);
        setSourceSetupError("");
        setConfluenceSessionState("");
        setConfluenceSourceGroupId("");
        setConfluenceSpaces([]);
        setGitHubSessionState(sessionState);
        setGitHubSetupLoading(true);
        void api
          .loadGitHubConnectionSession(sessionState)
          .then((session) => {
            if (cancelled) return;
            setGitHubSourceGroupId(session.sourceGroupId || "");
            setGitHubRepositories(session.items);
            const first = session.items[0];
            setSelectedRepositoryId(first?.id || "");
            setGitHubBranch(first?.defaultBranch || "main");
          })
          .catch((sessionError: unknown) => {
            if (cancelled) return;
            setGitHubSessionState("");
            setGitHubSourceGroupId("");
            setSourceSetupOpen(false);
            setSourceSetupError("");
            setSourcePickerNotice(
              sessionError instanceof Error
                ? "That GitHub connection expired. Choose a source to start again."
                : "Choose a source to start again.",
            );
            setAddSourceOpen(true);
            window.history.replaceState({}, "", window.location.pathname);
          })
          .finally(() => {
            if (!cancelled) setGitHubSetupLoading(false);
          });
      } else if (confluenceSession) {
        setView("sources");
        setSourceSetupOpen(true);
        setSourceSetupError("");
        setGitHubSessionState("");
        setGitHubSourceGroupId("");
        setGitHubRepositories([]);
        setConfluenceSessionState(confluenceSession);
        setConfluenceSetupLoading(true);
        void api
          .loadConfluenceConnectionSession(confluenceSession)
          .then((session) => {
            if (cancelled) return;
            setConfluenceSpaces(session.items);
            setSelectedConfluenceSpaceId(session.items[0]?.id || "");
            setConfluenceSourceGroupId(session.sourceGroupId || "");
          })
          .catch((sessionError: unknown) => {
            if (cancelled) return;
            setConfluenceSessionState("");
            setConfluenceSourceGroupId("");
            setSourceSetupOpen(false);
            setSourceSetupError("");
            setSourcePickerNotice(
              sessionError instanceof Error
                ? "That Confluence connection expired. Choose a source to start again."
                : "Choose a source to start again.",
            );
            setAddSourceOpen(true);
            window.history.replaceState({}, "", window.location.pathname);
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
    if (!loadOnMount) return;
    const activeRuns = runs.filter(
      (run) => run.status === "queued" || run.status === "running",
    );
    if (!activeRuns.length) return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void Promise.all(activeRuns.map((run) => api.loadRun(run.id)))
        .then(async (updatedRuns) => {
          if (cancelled) return;
          setRuns((current) =>
            current.map(
              (run) => updatedRuns.find((updated) => updated.id === run.id) || run,
            ),
          );
          if (
            updatedRuns.some(
              (run) => run.status === "succeeded" || run.status === "failed",
            )
          ) {
            const [nextChanges, nextRuns] = await Promise.all([
              api.loadChanges(filter),
              api.loadRuns(),
            ]);
            if (!cancelled) {
              setChanges(nextChanges);
              setRuns(nextRuns.items);
            }
          }
        })
        .catch(() => {
          // A later page refresh can resume polling from the persisted run state.
        });
    }, 900);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [api, filter, loadOnMount, runs]);

  useEffect(() => {
    if (!loadOnMount) return;
    let cancelled = false;
    let refreshing = false;
    const refreshWhenReturning = () => {
      if (
        document.visibilityState === "hidden" ||
        refreshing ||
        Date.now() - lastWorkspaceRefreshAt.current < 60_000
      ) {
        return;
      }

      refreshing = true;
      lastWorkspaceRefreshAt.current = Date.now();
      void Promise.all([api.loadRuns(), api.loadChanges(filter), api.loadSources()])
        .then(([nextRuns, nextChanges, nextSources]) => {
          if (cancelled) return;
          setRuns(nextRuns.items);
          setChanges(nextChanges);
          setSources(nextSources.items);
          setSourceGroups(nextSources.groups);
        })
        .catch(() => {
          // The next poll retries without interrupting the current screen.
        })
        .finally(() => {
          refreshing = false;
        });
    };

    window.addEventListener("focus", refreshWhenReturning);
    document.addEventListener("visibilitychange", refreshWhenReturning);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refreshWhenReturning);
      document.removeEventListener("visibilitychange", refreshWhenReturning);
    };
  }, [api, filter, loadOnMount]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setAnalyzeOpen(false);
      setAnalysisProgress(null);
      setSourceSetupOpen(false);
      setSelectedChange(null);
      setSelectedArtifact(null);
      setShowEvidence(false);
      setShowChangedArtifacts(false);
      setAddSourceOpen(false);
      setSourceConnectionContext(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const openCount = changes.counts.open;
  const visibleChanges = changes.items;
  const hasSources = sources.length > 0;
  const hasReadySource = sources.some((source) => source.status === "connected");
  const sourcesPreparing = sources.some(
    (source) => source.status === "pending" || source.status === "syncing",
  );
  const sourcesNeedAttention = sources.some(
    (source) => source.status === "error" || source.status === "disconnected",
  );
  const hasCompletedCheck = Boolean(
    changes.lastCheckedAt || runs.some((run) => run.status === "succeeded"),
  );
  const loadingWorkspace = loadingChanges || loadingSources;
  const showChangeFilters = changes.counts.total > 0 || (hasSources && hasCompletedCheck);
  const activeAnalysisRun = analysisProgress?.runId
    ? runs.find((run) => run.id === analysisProgress.runId) || null
    : null;

  function chooseView(nextView: View) {
    setView(nextView);
    setSelectedChange(null);
    setSelectedArtifact(null);
    setShowChangedArtifacts(false);
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
    setShowChangedArtifacts(false);
  }

  function closeChange() {
    setSelectedChange(null);
    setSelectedArtifact(null);
    setShowEvidence(false);
    setShowChangedArtifacts(false);
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

    setAnalyzeOpen(false);
    setAnalysisProgress({ target, runId: null, error: "" });
    setView("runs");

    try {
      const result = await api.startRun({
        target,
        sourceId: requestedSourceId || sources[0]?.id,
      });
      setRuns((current) => [result.run, ...current]);
      setAnalysisProgress((current) =>
        current?.target === target ? { target, runId: result.run.id, error: "" } : current,
      );
    } catch (runError) {
      setAnalysisProgress((current) =>
        current?.target === target
          ? {
              target,
              runId: null,
              error:
                runError instanceof Error
                  ? runError.message
                  : "The analysis could not be started.",
            }
          : current,
      );
    }
  }

  async function finishGitHubConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!githubSessionState || !selectedRepositoryId || !githubBranch.trim()) return;
    setSourceSetupError("");
    setGitHubSetupLoading(true);
    try {
      const result = await api.connectGitHubSource({
        sessionState: githubSessionState,
        repositoryId: selectedRepositoryId,
        branch: githubBranch.trim(),
      });
      await refreshSources();
      setGitHubSessionState("");
      setGitHubSourceGroupId("");
      setGitHubRepositories([]);
      setSourceSetupOpen(false);
      setSourceSetupError("");
      window.history.replaceState({}, "", window.location.pathname);
      setToast(
        githubSourceGroupId && result.alreadyInGroup && result.alreadyTracked
          ? `${result.source.name} is already in this connected group`
          : githubSourceGroupId && result.alreadyTracked
            ? `${result.source.name} added to this connected group`
          : result.alreadyTracked
            ? `${result.source.name} was already connected`
            : `${result.source.name} connected. Preparing it now.`,
      );
    } catch (connectionError) {
      setSourceSetupError(
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
    setSourceSetupError("");
    setConfluenceSetupLoading(true);
    try {
      const result = await api.connectConfluenceSource({
        sessionState: confluenceSessionState,
        spaceId: selectedConfluenceSpaceId,
      });
      await refreshSources();
      setConfluenceSessionState("");
      setConfluenceSourceGroupId("");
      setConfluenceSpaces([]);
      setSourceSetupOpen(false);
      setSourceSetupError("");
      window.history.replaceState({}, "", window.location.pathname);
      setToast(
        confluenceSourceGroupId && result.alreadyInGroup && result.alreadyTracked
          ? `${result.source.name} is already in this connected group`
          : confluenceSourceGroupId && result.alreadyTracked
            ? `${result.source.name} added to this connected group`
          : result.alreadyTracked
            ? `${result.source.name} was already connected`
            : `${result.source.name} connected. Preparing it now.`,
      );
    } catch (connectionError) {
      setSourceSetupError(
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
      setToast(`${result.source.name} check started`);
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

  function openAddSource(context: SourceConnectionContext | null = null) {
    setSourceConnectionContext(context);
    setSourcePickerNotice("");
    setAddSourceOpen(true);
  }

  function closeAddSource() {
    setAddSourceOpen(false);
    setSourcePickerNotice("");
    setSourceConnectionContext(null);
  }

  function closeSourceSetup() {
    setSourceSetupOpen(false);
    setSourceSetupError("");
    setGitHubSessionState("");
    setGitHubSourceGroupId("");
    setGitHubRepositories([]);
    setConfluenceSessionState("");
    setConfluenceSourceGroupId("");
    setConfluenceSpaces([]);
    window.history.replaceState({}, "", window.location.pathname);
  }

  function requestAnalysis() {
    if (!sources.length) {
      openAddSource();
      return;
    }
    if (!hasReadySource) {
      setView("sources");
      setToast("Your sources are still being prepared.");
      return;
    }
    setAnalyzeOpen(true);
  }

  function renderSourceNode(source: SourceItem) {
    const name = source.provider === "github" ? repositoryName(source) : source.name;
    const detail = source.provider === "github"
      ? [repositoryOwner(source), source.detail].filter(Boolean).join(" · ")
      : source.detail;

    return (
      <article className="source-node" key={source.id}>
        <div className="source-node-heading">
          <span className="source-monogram" aria-hidden="true">
            {source.provider === "github" ? "GH" : "CF"}
          </span>
          <div className="source-node-copy">
            <span className="source-provider">
              {source.provider === "github" ? "GitHub repository" : "Confluence space"}
            </span>
            <strong>{name}</strong>
            <small>{detail}</small>
          </div>
          <span className={`source-status ${source.status}`}>
            {sourceStatus(source)}
          </span>
        </div>

        <div className="source-node-contents">
          <small className="source-freshness">{sourceFreshness(source)}</small>
          {source.provider === "github" ? (
            <>
              <span>{indexedFiles(source.codeArtifactCount)} of source code</span>
              <span>{indexedFiles(source.documentationArtifactCount)} of repository documentation</span>
            </>
          ) : (
            <span>{indexedPages(source.documentationArtifactCount)}</span>
          )}
        </div>

        <div className="source-node-actions">
          <span>
            <button
              type="button"
              className="source-sync"
              disabled={
                Boolean(syncingSourceId) ||
                source.status === "syncing" ||
                source.status === "pending"
              }
              aria-label={`Check ${name} for updates`}
              onClick={() => void syncSource(source.id)}
            >
              {syncingSourceId === source.id
                ? "Checking…"
                : source.status === "syncing" || source.status === "pending"
                  ? "Preparing…"
                  : "Check for updates"}
            </button>
            <button
              type="button"
              className="source-remove"
              disabled={Boolean(syncingSourceId || removingSourceId)}
              aria-label={`Remove ${name}`}
              onClick={() => setSourcePendingRemoval(source)}
            >
              Remove
            </button>
          </span>
        </div>
      </article>
    );
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

        <div className="topbar-actions">
          <button type="button" className="primary-action" onClick={requestAnalysis}>
            Analyze
          </button>
          {accountAction}
        </div>
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
                {loadingWorkspace
                  ? "Checking your workspace"
                  : openCount > 0
                    ? `${openCount} ${openCount === 1 ? "change needs" : "changes need"} your attention`
                    : !hasSources
                      ? "Connect your first source"
                      : sourcesNeedAttention
                        ? "A source needs attention"
                        : sourcesPreparing
                          ? "Preparing your sources"
                          : !hasCompletedCheck
                            ? "Ready for your first check"
                            : "Everything is up to date"}
              </h1>
              <p>
                {openCount > 0
                  ? "Review what changed, what may now be outdated, and the evidence connecting them."
                  : !hasSources && !loadingWorkspace
                    ? "Connect code and documentation so SpecGraph can show what may need updating."
                    : sourcesNeedAttention
                      ? "Open Sources to reconnect or try checking the source again."
                      : sourcesPreparing
                        ? "We’re indexing what you connected. You can leave this page while it finishes."
                        : !hasCompletedCheck
                          ? "Your sources are connected. Run a check to find linked updates."
                          : "We watch your connected docs and code. When something changes, we show what else may need updating."}
              </p>
            </section>

            {showChangeFilters && (
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
            )}

            <section
              className={`change-list${showChangeFilters ? "" : " onboarding-list"}`}
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
                  <strong>
                    {!hasSources
                      ? "Nothing is connected yet."
                      : sourcesNeedAttention
                        ? "A connected source needs attention."
                        : sourcesPreparing
                          ? "Your sources are being prepared."
                          : !hasCompletedCheck
                            ? "Everything is ready for a first check."
                            : filter === "open"
                              ? "No open changes."
                              : "No changes yet."}
                  </strong>
                  <span>
                    {!hasSources
                      ? "Add a repository or documentation source to begin."
                      : sourcesNeedAttention
                        ? "Review its connection before relying on the latest results."
                        : sourcesPreparing
                          ? "We’ll let you know when they are ready to check."
                          : !hasCompletedCheck
                            ? "Run a check to see whether connected items may be outdated."
                            : "We’ll add one here when something needs attention."}
                  </span>
                  {!hasSources && (
                    <button
                      type="button"
                      className="primary-action empty-action"
                      onClick={() => openAddSource()}
                    >
                      Connect your first source
                    </button>
                  )}
                  {hasSources &&
                    !sourcesPreparing &&
                    !sourcesNeedAttention &&
                    !hasCompletedCheck && (
                      <button
                        type="button"
                        className="primary-action empty-action"
                        onClick={requestAnalysis}
                      >
                        Run your first check
                      </button>
                    )}
                  {hasSources && sourcesNeedAttention && openCount === 0 && (
                    <button
                      type="button"
                      className="text-action empty-action"
                      onClick={() => chooseView("sources")}
                    >
                      Review sources
                    </button>
                  )}
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
                  <span>
                    {runResult(run)}
                    {run.status === "failed" && run.errorMessage && (
                      <small>{run.errorMessage}</small>
                    )}
                  </span>
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
              <p>SpecGraph watches the sources you connect.</p>
            </section>
            <section
              className="source-graph"
              aria-label="Connected sources"
              aria-busy={loadingSources}
            >
              {sourceGroups.map((group) => {
                const sourceNames = group.sources
                  .map((source) =>
                    source.provider === "github" ? repositoryName(source) : source.name,
                  )
                  .join(", ");
                return (
                  <div className="source-cluster" key={group.id}>
                    <div
                      className="source-members"
                      aria-label={`Connected source group containing ${sourceNames}`}
                    >
                      {group.sources.map((source, index) => (
                        <Fragment key={source.id}>
                          {index > 0 && (
                            <div className="source-link" aria-hidden="true">
                              <div className="source-link-track">
                                <span />
                                <b>↕</b>
                                <span />
                              </div>
                            </div>
                          )}
                          {renderSourceNode(source)}
                        </Fragment>
                      ))}
                    </div>
                    <div className="source-cluster-actions">
                      <button
                        type="button"
                        className="source-connect"
                        aria-label="Connect source"
                        onClick={() => openAddSource({ groupId: group.id })}
                      >
                        + Connect source
                      </button>
                    </div>
                  </div>
                );
              })}
              {!loadingSources && !sources.length && (
                <div className="empty-message">
                  <strong>No sources connected.</strong>
                  <span>Add a repository or documentation source to start tracking them.</span>
                </div>
              )}
            </section>
            <button type="button" className="text-action" onClick={() => openAddSource()}>
              + Add source
            </button>
          </>
        )}
      </main>

      {addSourceOpen && (
        <div
          className="scrim modal-scrim"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeAddSource();
          }}
        >
          <section className="analyze-modal source-picker" role="dialog" aria-modal="true" aria-labelledby="add-source-title">
            <header>
              <h2 id="add-source-title">
                {sources.length ? "Connect more sources together" : "Add your first source"}
              </h2>
              <button type="button" onClick={closeAddSource} aria-label="Close source chooser">×</button>
            </header>
            <p>
              {sourceConnectionContext
                ? "Choose another source to add to this connected group."
                : "Choose what SpecGraph should watch."}
            </p>
            {sourcePickerNotice && (
              <div className="source-picker-notice" role="status">
                {sourcePickerNotice}
              </div>
            )}
            <div className="source-provider-options">
              {githubConfigured === false ? (
                <span className="provider-option disabled"><strong>GitHub repository</strong><small>Needs one-time configuration</small></span>
              ) : (
                <a
                  className="provider-option"
                  href={sourceConnectionContext
                    ? `/api/github/connect?group_id=${encodeURIComponent(sourceConnectionContext.groupId)}`
                    : "/api/github/connect"}
                >
                  <strong>GitHub repository</strong><small>Code and repository documentation</small><Arrow />
                </a>
              )}
              {confluenceConfigured === false ? (
                <span className="provider-option disabled"><strong>Confluence documentation</strong><small>Available after hosting and OAuth setup</small></span>
              ) : (
                <a
                  className="provider-option"
                  href={sourceConnectionContext
                    ? `/api/confluence/connect?group_id=${encodeURIComponent(sourceConnectionContext.groupId)}`
                    : "/api/confluence/connect"}
                >
                  <strong>Confluence documentation</strong><small>Site and space</small><Arrow />
                </a>
              )}
              <span className="provider-option disabled" aria-disabled="true">
                <strong>Notion documentation</strong>
                <small>Connection coming next</small>
              </span>
              <span className="provider-option disabled" aria-disabled="true">
                <strong>Google Docs</strong>
                <small>Connection coming next</small>
              </span>
            </div>
          </section>
        </div>
      )}

      {sourceSetupOpen && (githubSessionState || confluenceSessionState) && (
        <div
          className="scrim modal-scrim"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeSourceSetup();
          }}
        >
          <section
            className="analyze-modal source-setup-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="source-setup-title"
          >
            <header>
              <h2 id="source-setup-title">
                {githubSessionState ? "Choose a repository" : "Choose documentation"}
              </h2>
              <button
                type="button"
                onClick={closeSourceSetup}
                aria-label={
                  githubSessionState
                    ? "Close repository chooser"
                    : "Close documentation chooser"
                }
              >
                ×
              </button>
            </header>
            <p>
              {githubSessionState
                ? "Select the repository and branch SpecGraph should watch. Repository documentation is included automatically."
                : "Select the Confluence space SpecGraph should watch."}
            </p>

            {sourceSetupError &&
              Boolean(githubRepositories.length || confluenceSpaces.length) && (
                <div className="source-setup-state error" role="alert">
                  <strong>SpecGraph couldn’t connect this source.</strong>
                  <span>{sourceSetupError}</span>
                </div>
              )}

            {sourceSetupError &&
            !githubRepositories.length &&
            !confluenceSpaces.length ? (
              <div className="source-setup-state error" role="alert">
                <strong>SpecGraph couldn’t load this source.</strong>
                <span>{sourceSetupError}</span>
              </div>
            ) : githubSetupLoading && !githubRepositories.length ? (
              <div className="source-setup-state" role="status">
                <strong>Loading repositories…</strong>
                <span>This should only take a moment.</span>
              </div>
            ) : confluenceSetupLoading && !confluenceSpaces.length ? (
              <div className="source-setup-state" role="status">
                <strong>Loading Confluence spaces…</strong>
                <span>This should only take a moment.</span>
              </div>
            ) : githubSessionState && githubRepositories.length ? (
              <form onSubmit={(event) => void finishGitHubConnection(event)}>
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
                  autoFocus
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
                <footer>
                  <button type="button" className="dismiss-action" onClick={closeSourceSetup}>
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="primary-action wide"
                    disabled={githubSetupLoading}
                  >
                    {githubSetupLoading ? "Preparing repository…" : "Connect repository"}
                  </button>
                </footer>
              </form>
            ) : confluenceSessionState && confluenceSpaces.length ? (
              <form onSubmit={(event) => void finishConfluenceConnection(event)}>
                <label htmlFor="confluence-space">Space</label>
                <select
                  id="confluence-space"
                  value={selectedConfluenceSpaceId}
                  onChange={(event) => setSelectedConfluenceSpaceId(event.target.value)}
                  autoFocus
                >
                  {confluenceSpaces.map((space) => (
                    <option key={`${space.cloudId}:${space.id}`} value={space.id}>
                      {space.siteName} / {space.name}
                    </option>
                  ))}
                </select>
                <footer>
                  <button type="button" className="dismiss-action" onClick={closeSourceSetup}>
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="primary-action wide"
                    disabled={confluenceSetupLoading}
                  >
                    {confluenceSetupLoading
                      ? "Preparing documentation…"
                      : "Connect documentation"}
                  </button>
                </footer>
              </form>
            ) : (
              <div className="source-setup-state">
                <strong>No sources are available.</strong>
                <span>Check the provider account permissions and try again.</span>
              </div>
            )}
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

            <section className="details-section affected-section">
              <h3>
                What may need updating
                {selectedChange.affected > 0 && <span>{selectedChange.affected}</span>}
              </h3>
              {selectedChange.artifacts.length ? (
                <div className="artifact-list">
                  {selectedChange.artifacts.map((artifact) => {
                    const expanded = selectedArtifact?.id === artifact.id;
                    const detailsId = `artifact-details-${artifact.id}`;

                    return (
                      <div className="artifact-item" key={artifact.id}>
                        <button
                          type="button"
                          className="artifact-row"
                          aria-expanded={expanded}
                          aria-controls={detailsId}
                          onClick={() =>
                            setSelectedArtifact((current) =>
                              current?.id === artifact.id ? null : artifact,
                            )
                          }
                        >
                          <span>
                            <strong>{artifact.name}</strong>
                            <small>
                              {artifact.kind} <span aria-hidden="true">·</span>{" "}
                              {artifact.location}
                            </small>
                          </span>
                          <span aria-hidden="true">{expanded ? "−" : "+"}</span>
                        </button>

                        {expanded && (
                          <div className="artifact-preview" id={detailsId}>
                            <p>{artifact.reason}</p>
                            <div
                              className="relationship-evidence"
                              aria-label="Verified relationship evidence"
                            >
                              <strong>{relationshipSignal(artifact)}</strong>
                              <span>
                                Relationship evidence <span aria-hidden="true">·</span>{" "}
                                {artifact.evidenceLocation}
                              </span>
                              <blockquote>{artifact.excerpt}</blockquote>
                            </div>
                            <div className="artifact-preview-links">
                              {artifact.evidenceUrl && (
                                <a href={artifact.evidenceUrl} target="_blank" rel="noreferrer">
                                  Open evidence <Arrow />
                                </a>
                              )}
                              {artifact.externalUrl &&
                                artifact.externalUrl !== artifact.evidenceUrl && (
                                  <a href={artifact.externalUrl} target="_blank" rel="noreferrer">
                                    Open affected source <Arrow />
                                  </a>
                                )}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="analysis-message">
                  {selectedChange.status === "processing"
                    ? "Analysis is still running."
                    : "No affected items were found."}
                </p>
              )}

            </section>

            <section className="details-section changed-section">
              <button
                type="button"
                className="details-section-toggle"
                aria-expanded={showChangedArtifacts}
                aria-controls={`changed-artifacts-${selectedChange.id}`}
                onClick={() => setShowChangedArtifacts((current) => !current)}
              >
                <span>What changed</span>
                <span>
                  {selectedChange.changedArtifacts.length > 0 && (
                    <small>{selectedChange.changedArtifacts.length}</small>
                  )}
                  <b aria-hidden="true">{showChangedArtifacts ? "−" : "+"}</b>
                </span>
              </button>
              {showChangedArtifacts && (
                <div id={`changed-artifacts-${selectedChange.id}`}>
                  {selectedChange.changedArtifacts.length ? (
                    <div className="changed-artifact-list">
                      {selectedChange.changedArtifacts.map((artifact) => {
                        const content = (
                          <>
                            <span>
                              <strong>{artifact.location}</strong>
                              <small>{artifact.kind}</small>
                            </span>
                            {artifact.externalUrl && <Arrow />}
                          </>
                        );
                        return artifact.externalUrl ? (
                          <a
                            className="changed-artifact-row"
                            href={artifact.externalUrl}
                            key={artifact.id}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {content}
                          </a>
                        ) : (
                          <div className="changed-artifact-row" key={artifact.id}>
                            {content}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p>{selectedChange.summary}</p>
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
            <p>Enter a GitHub pull request or an indexed documentation page.</p>
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
                placeholder="#842, Refund policy, or a page URL"
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

      {analysisProgress && (
        <div
          className="scrim modal-scrim"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setAnalysisProgress(null);
          }}
        >
          <section
            className="analyze-modal analysis-progress-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="analysis-progress-title"
            aria-describedby="analysis-progress-copy"
          >
            <header>
              <h2 id="analysis-progress-title">
                {analysisProgress.error
                  ? "Analysis couldn’t start"
                  : activeAnalysisRun?.status === "failed"
                    ? "Analysis couldn’t finish"
                    : activeAnalysisRun?.status === "succeeded"
                      ? "Analysis complete"
                      : "Analysis in progress"}
              </h2>
              <button
                type="button"
                onClick={() => setAnalysisProgress(null)}
                aria-label="Close analysis progress"
              >
                ×
              </button>
            </header>
            <div
              className={
                analysisProgress.error || activeAnalysisRun?.status === "failed"
                  ? "analysis-progress-mark failed"
                  : activeAnalysisRun?.status === "succeeded"
                    ? "analysis-progress-mark complete"
                    : "analysis-progress-mark"
              }
              aria-hidden="true"
            >
              <span />
              <span />
              <span />
            </div>
            <p id="analysis-progress-copy" aria-live="polite">
              {analysisProgress.error
                ? analysisProgress.error
                : activeAnalysisRun?.status === "failed"
                  ? activeAnalysisRun.errorMessage || "SpecGraph could not finish this check."
                  : activeAnalysisRun?.status === "succeeded"
                    ? `SpecGraph finished checking ${analysisProgress.target}.`
                    : `SpecGraph is checking ${analysisProgress.target}. You can close this dialog; the run will continue in the background.`}
            </p>
            <footer>
              <button
                type="button"
                className="primary-action wide"
                autoFocus
                onClick={() => setAnalysisProgress(null)}
              >
                {analysisProgress.error || activeAnalysisRun?.status === "failed"
                  ? "Close"
                  : activeAnalysisRun?.status === "succeeded"
                    ? "View results"
                    : "Continue in background"}
              </button>
            </footer>
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
