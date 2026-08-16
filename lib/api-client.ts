import type {
  ChangeFilter,
  ChangeItem,
  ChangeListResponse,
  ConnectGitHubSourceInput,
  ConnectGitHubSourceResponse,
  FindingAction,
  GitHubConnectionSessionResponse,
  GitHubStatusResponse,
  RunItem,
  RunListResponse,
  SourceListResponse,
  StartRunInput,
  StartRunResponse,
  SyncSourceResponse,
} from "./contracts/specgraph";

export type SpecGraphApi = {
  loadChanges(filter: ChangeFilter): Promise<ChangeListResponse>;
  loadChange(id: string): Promise<ChangeItem>;
  updateChange(id: string, action: FindingAction): Promise<ChangeItem>;
  loadRuns(): Promise<RunListResponse>;
  loadRun(id: string): Promise<RunItem>;
  startRun(input: StartRunInput): Promise<StartRunResponse>;
  loadSources(): Promise<SourceListResponse>;
  loadGitHubStatus(): Promise<GitHubStatusResponse>;
  loadGitHubConnectionSession(state: string): Promise<GitHubConnectionSessionResponse>;
  connectGitHubSource(input: ConnectGitHubSourceInput): Promise<ConnectGitHubSourceResponse>;
  syncSource(id: string): Promise<SyncSourceResponse>;
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
  syncSource(id) {
    return requestJson<SyncSourceResponse>(`/api/sources/${id}/sync`, {
      method: "POST",
    });
  },
};
