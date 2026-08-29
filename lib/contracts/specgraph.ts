export type ChangeFilter = "open" | "all";
export type ChangeStatus =
  | "open"
  | "scheduled"
  | "processing"
  | "resolved"
  | "dismissed"
  | "reviewed";
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
  | "Code"
  | "File";

export type RelationshipOrigin = "deterministic" | "semantic" | "hybrid";
export type RelationshipProvenance =
  | "USER_DEFINED"
  | "EXPLICIT_LINK"
  | "EXACT_PATH"
  | "IMPORT"
  | "TEST_NAMING"
  | "OPENAPI_ENTITY"
  | "EXACT_IDENTIFIER"
  | "SHARED_ENTITY"
  | "SEMANTIC"
  | "CO_CHANGE"
  | "STRUCTURAL"
  | "LEGACY";

export type ChangedArtifact = {
  id: string;
  name: string;
  kind: ArtifactKind;
  location: string;
  externalUrl: string | null;
};

export type AffectedArtifact = {
  id: string;
  name: string;
  kind: ArtifactKind;
  location: string;
  changedArtifact: ChangedArtifact | null;
  evidenceLocation: string;
  excerpt: string;
  reason: string;
  confidence: number;
  origin: RelationshipOrigin;
  provenance: RelationshipProvenance;
  externalUrl: string | null;
  evidenceUrl: string | null;
  reviewStatus: FindingReviewStatus;
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
  changedArtifacts: ChangedArtifact[];
  artifacts: AffectedArtifact[];
};

export type ChangeListResponse = {
  items: ChangeItem[];
  counts: {
    open: number;
    scheduled: number;
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
  progress: number;
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
  lastError: string | null;
  lastSyncedAt: string | null;
  artifactCount: number;
  codeArtifactCount: number;
  documentationArtifactCount: number;
  canonicalUrl: string | null;
};

export type SourceGroup = {
  id: string;
  sources: SourceItem[];
};

export type SourceListResponse = {
  items: SourceItem[];
  groups: SourceGroup[];
};

export type StartRunInput = {
  target: string;
  sourceId?: string;
};

export type StartRunResponse = {
  run: RunItem;
};

export type GitHubRepositoryCandidate = {
  id: string;
  installationId: string;
  fullName: string;
  owner: string;
  name: string;
  defaultBranch: string;
  private: boolean;
  accountLogin: string;
  accountType: string;
};

export type GitHubConnectionSessionResponse = {
  items: GitHubRepositoryCandidate[];
  expiresAt: string;
  sourceGroupId: string | null;
};

export type GitHubStatusResponse = {
  configured: boolean;
};

export type ConnectGitHubSourceInput = {
  sessionState: string;
  repositoryId: string;
  branch: string;
};

export type ConnectGitHubSourceResponse = {
  source: SourceItem;
  alreadyTracked: boolean;
  alreadyInGroup: boolean;
  sourceGroupId: string;
};

export type ConfluenceStatusResponse = {
  configured: boolean;
};

export type ConfluenceSpaceCandidate = {
  id: string;
  key: string;
  name: string;
  cloudId: string;
  siteName: string;
  siteUrl: string;
};

export type ConfluenceConnectionSessionResponse = {
  items: ConfluenceSpaceCandidate[];
  expiresAt: string;
  sourceGroupId: string | null;
};

export type ConnectConfluenceSourceInput = {
  sessionState: string;
  spaceId: string;
};

export type ConnectConfluenceSourceResponse = {
  source: SourceItem;
  alreadyTracked: boolean;
  alreadyInGroup: boolean;
  sourceGroupId: string;
};

export type ConnectSourceGroupInput = {
  sourceIds: string[];
};

export type ConnectSourceGroupResponse = {
  groupId: string;
  alreadyTracked: boolean;
};

export type SyncSourceResponse = {
  source: SourceItem;
};

export type RemoveSourceResponse = {
  removedSourceId: string;
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
    counts: { open: 0, scheduled: 0, total: 0 },
    lastCheckedAt: null,
  },
  runs: { items: [] },
  sources: { items: [], groups: [] },
};
