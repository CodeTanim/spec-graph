export type ChangeFilter = "open" | "all";
export type ChangeStatus = "open" | "processing" | "checked";
export type FindingReviewStatus = "open" | "resolved" | "dismissed";
export type FindingAction = "dismiss" | "resolve" | "reopen";
export type RunStatus = "queued" | "running" | "succeeded" | "failed";
export type RunTrigger = "manual" | "github" | "confluence" | "scheduled";
export type SourceProvider = "github" | "confluence";
export type SourceStatus =
  | "pending"
  | "syncing"
  | "connected"
  | "error"
  | "disconnected";
export type ArtifactKind =
  | "Confluence"
  | "OpenAPI"
  | "Test"
  | "Markdown"
  | "Code";

export type AffectedArtifact = {
  id: string;
  name: string;
  kind: ArtifactKind;
  location: string;
  excerpt: string;
  reason: string;
  externalUrl: string | null;
};

export type ChangeItem = {
  id: string;
  runId: string;
  title: string;
  source: string;
  sourceUrl: string | null;
  occurredAt: string;
  status: ChangeStatus;
  affected: number;
  summary: string;
  evidence: string;
  artifacts: AffectedArtifact[];
};

export type ChangeListResponse = {
  items: ChangeItem[];
  counts: {
    open: number;
    total: number;
  };
  lastCheckedAt: string | null;
};

export type RunItem = {
  id: string;
  title: string;
  trigger: RunTrigger;
  target: string;
  status: RunStatus;
  createdAt: string;
  completedAt: string | null;
  findingsCount: number;
  errorMessage: string | null;
};

export type RunListResponse = {
  items: RunItem[];
};

export type SourceItem = {
  id: string;
  provider: SourceProvider;
  name: string;
  detail: string;
  status: SourceStatus;
  lastSyncedAt: string | null;
};

export type SourceListResponse = {
  items: SourceItem[];
};

export type StartRunInput = {
  target: string;
  sourceId?: string;
};

export type StartRunResponse = {
  run: RunItem;
};

export type UpdateChangeInput = {
  action: FindingAction;
};

export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
  };
};

export type DashboardSnapshot = {
  changes: ChangeListResponse;
  runs: RunListResponse;
  sources: SourceListResponse;
};

export const emptyDashboardSnapshot: DashboardSnapshot = {
  changes: {
    items: [],
    counts: { open: 0, total: 0 },
    lastCheckedAt: null,
  },
  runs: { items: [] },
  sources: { items: [] },
};
