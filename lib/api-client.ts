import type {
  ChangeFilter,
  ChangeItem,
  ChangeListResponse,
  ConnectGitHubSourceInput,
  ConnectGitHubSourceResponse,
  ConnectConfluenceSourceInput,
  ConnectConfluenceSourceResponse,
  ConfluenceConnectionSessionResponse,
  ConfluenceStatusResponse,
  FindingAction,
  GitHubConnectionSessionResponse,
  GitHubStatusResponse,
  RunItem,
  RunListResponse,
  RemoveSourceResponse,
  RetryRunResponse,
  SourceListResponse,
  StartRunInput,
  StartRunResponse,
  SyncSourceResponse,
} from "./contracts/specgraph";

export type SpecGraphApi = {
  loadChanges(filter: ChangeFilter): Promise<ChangeListResponse>;
  loadChange(id: string): Promise<ChangeItem>;
  updateChange(id: string, action: FindingAction): Promise<ChangeItem>;
  updateFinding(
    changeId: string,
    findingId: string,
    action: FindingAction,
  ): Promise<ChangeItem>;
  loadRuns(): Promise<RunListResponse>;
  loadRun(id: string): Promise<RunItem>;
  startRun(input: StartRunInput): Promise<StartRunResponse>;
  retryRun(id: string): Promise<RetryRunResponse>;
  loadSources(): Promise<SourceListResponse>;
  loadGitHubStatus(): Promise<GitHubStatusResponse>;
  loadGitHubConnectionSession(state: string): Promise<GitHubConnectionSessionResponse>;
  connectGitHubSource(input: ConnectGitHubSourceInput): Promise<ConnectGitHubSourceResponse>;
  loadConfluenceStatus(): Promise<ConfluenceStatusResponse>;
  loadConfluenceConnectionSession(state: string): Promise<ConfluenceConnectionSessionResponse>;
  connectConfluenceSource(input: ConnectConfluenceSourceInput): Promise<ConnectConfluenceSourceResponse>;
  syncSource(id: string): Promise<SyncSourceResponse>;
  removeSource(id: string): Promise<RemoveSourceResponse>;
};

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  const payload = (await response.json().catch(() => null)) as
    | { error?: { message?: string } }
    | null;

  if (!response.ok) {
    throw new Error(payload?.error?.message || "SpecGraph could not complete that request.");
  }

  return payload as T;
}

export const httpSpecGraphApi: SpecGraphApi = {
  loadChanges(filter) {
    return requestJson<ChangeListResponse>(`/api/changes?status=${filter}`);
  },
  async loadChange(id) {
    const result = await requestJson<{ item: ChangeItem }>(`/api/changes/${id}`);
    return result.item;
  },
  async updateChange(id, action) {
    const result = await requestJson<{ item: ChangeItem }>(`/api/changes/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ action }),
    });
    return result.item;
  },
  async updateFinding(changeId, findingId, action) {
    const result = await requestJson<{ item: ChangeItem }>(
      `/api/changes/${changeId}/findings/${findingId}`,
      {
        method: "PATCH",
        body: JSON.stringify({ action }),
      },
    );
    return result.item;
  },
  loadRuns() {
    return requestJson<RunListResponse>("/api/runs");
  },
  async loadRun(id) {
    const result = await requestJson<{ run: RunItem }>(`/api/runs/${id}`);
    return result.run;
  },
  startRun(input) {
    return requestJson<StartRunResponse>("/api/runs", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  retryRun(id) {
    return requestJson<RetryRunResponse>(`/api/runs/${id}/retry`, {
      method: "POST",
    });
  },
  loadSources() {
    return requestJson<SourceListResponse>("/api/sources");
  },
  loadGitHubStatus() {
    return requestJson<GitHubStatusResponse>("/api/github/status");
  },
  loadGitHubConnectionSession(state) {
    return requestJson<GitHubConnectionSessionResponse>(
      `/api/github/repositories?session=${encodeURIComponent(state)}`,
    );
  },
  connectGitHubSource(input) {
    return requestJson<ConnectGitHubSourceResponse>("/api/github/sources", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  loadConfluenceStatus() {
    return requestJson<ConfluenceStatusResponse>("/api/confluence/status");
  },
  loadConfluenceConnectionSession(state) {
    return requestJson<ConfluenceConnectionSessionResponse>(
      `/api/confluence/spaces?session=${encodeURIComponent(state)}`,
    );
  },
  connectConfluenceSource(input) {
    return requestJson<ConnectConfluenceSourceResponse>("/api/confluence/sources", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  syncSource(id) {
    return requestJson<SyncSourceResponse>(`/api/sources/${id}/sync`, {
      method: "POST",
    });
  },
  removeSource(id) {
    return requestJson<RemoveSourceResponse>(`/api/sources/${id}`, {
      method: "DELETE",
    });
  },
};
