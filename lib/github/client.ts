import { ApiError } from "../server/http";
import { createGitHubAppJwt } from "./crypto";
import type { GitHubAppConfig, GitHubOAuthConfig } from "./config";
import type { GitHubSourceProvider } from "../providers/source-provider";
import type {
  GitHubPullFile,
  GitHubPullRequest,
  GitHubRepositoryCandidate,
  GitHubTreeEntry,
} from "./types";

const API_VERSION = "2026-03-10";

type Fetcher = typeof fetch;

function splitRepository(fullName: string): { owner: string; repo: string } {
  const [owner, repo, ...rest] = fullName.split("/");
  if (!owner || !repo || rest.length) {
    throw new ApiError(400, "INVALID_REPOSITORY", "That GitHub repository is invalid.");
  }
  return { owner, repo };
}

function decodeBase64(value: string): string {
  const binary = atob(value.replace(/\s/g, ""));
  return new TextDecoder().decode(
    Uint8Array.from(binary, (character) => character.charCodeAt(0)),
  );
}

export class GitHubClient implements GitHubSourceProvider {
  readonly provider = "github" as const;
  constructor(
    private readonly config: GitHubOAuthConfig | GitHubAppConfig,
    private readonly fetcher: Fetcher = fetch,
  ) {}

  private async request<T>(
    url: string,
    token: string,
    init: RequestInit = {},
  ): Promise<T> {
    const response = await this.fetcher(url, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "SpecGraph",
        "x-github-api-version": API_VERSION,
        ...init.headers,
      },
    });

    const payload = (await response.json().catch(() => null)) as
      | { message?: string }
      | T
      | null;
    if (!response.ok) {
      const message =
        payload && typeof payload === "object" && "message" in payload
          ? payload.message
          : null;
      throw new ApiError(
        response.status === 404 ? 404 : 502,
        response.status === 404 ? "GITHUB_NOT_FOUND" : "GITHUB_API_ERROR",
        message || "GitHub could not complete that request.",
      );
    }
    return payload as T;
  }

  async exchangeOAuthCode(code: string, redirectUri: string): Promise<string> {
    const response = await this.fetcher("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "SpecGraph",
      },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });
    const payload = (await response.json().catch(() => null)) as {
      access_token?: string;
      error?: string;
      error_description?: string;
    } | null;
    if (!response.ok || !payload?.access_token) {
      throw new ApiError(
        502,
        "GITHUB_AUTHORIZATION_FAILED",
        payload?.error_description || "GitHub authorization could not be completed.",
      );
    }
    return payload.access_token;
  }

  async listUserRepositories(userToken: string): Promise<GitHubRepositoryCandidate[]> {
    const installations = await this.request<{
      installations: Array<{
        id: number;
        account: { login: string; type: string };
        suspended_at: string | null;
      }>;
    }>("https://api.github.com/user/installations?per_page=20", userToken);

    const candidates: GitHubRepositoryCandidate[] = [];
    for (const installation of installations.installations.slice(0, 20)) {
      if (installation.suspended_at) continue;
      const repositories = await this.request<{
        repositories: Array<{
          id: number;
          full_name: string;
          name: string;
          private: boolean;
          default_branch: string;
          owner: { login: string };
        }>;
      }>(
        `https://api.github.com/user/installations/${installation.id}/repositories?per_page=100`,
        userToken,
      );
      for (const repository of repositories.repositories) {
        candidates.push({
          id: String(repository.id),
          installationId: String(installation.id),
          fullName: repository.full_name,
          owner: repository.owner.login,
          name: repository.name,
          defaultBranch: repository.default_branch,
          private: repository.private,
          accountLogin: installation.account.login,
          accountType: installation.account.type,
        });
      }
    }
    return candidates.slice(0, 100);
  }

  private async installationToken(installationId: string): Promise<string> {
    if (!("appId" in this.config) || !("privateKey" in this.config)) {
      throw new ApiError(503, "GITHUB_NOT_CONFIGURED", "GitHub App access is unavailable.");
    }
    const jwt = await createGitHubAppJwt(this.config.appId, this.config.privateKey);
    const response = await this.request<{ token: string }>(
      `https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
      jwt,
      { method: "POST" },
    );
    return response.token;
  }

  async branchRevision(
    installationId: string,
    fullName: string,
    branch: string,
  ): Promise<string> {
    const token = await this.installationToken(installationId);
    const { owner, repo } = splitRepository(fullName);
    const result = await this.request<{ commit: { sha: string } }>(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches/${encodeURIComponent(branch)}`,
      token,
    );
    return result.commit.sha;
  }

  async repositoryTree(
    installationId: string,
    fullName: string,
    revision: string,
  ): Promise<{ entries: GitHubTreeEntry[]; truncated: boolean; token: string }> {
    const token = await this.installationToken(installationId);
    const { owner, repo } = splitRepository(fullName);
    const result = await this.request<{
      tree: GitHubTreeEntry[];
      truncated: boolean;
    }>(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(revision)}?recursive=1`,
      token,
    );
    return { entries: result.tree, truncated: result.truncated, token };
  }

  async blob(fullName: string, sha: string, token: string): Promise<string> {
    const { owner, repo } = splitRepository(fullName);
    const result = await this.request<{ content: string; encoding: string }>(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${encodeURIComponent(sha)}`,
      token,
    );
    if (result.encoding !== "base64") {
      throw new ApiError(502, "GITHUB_CONTENT_ENCODING", "GitHub returned unsupported content.");
    }
    return decodeBase64(result.content);
  }

  async pullRequest(
    installationId: string,
    fullName: string,
    number: number,
  ): Promise<{ pull: GitHubPullRequest; files: GitHubPullFile[] }> {
    const token = await this.installationToken(installationId);
    const { owner, repo } = splitRepository(fullName);
    const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const pull = await this.request<{
      number: number;
      title: string;
      html_url: string;
      user: { login: string };
      base: { sha: string };
      head: { sha: string };
      changed_files: number;
    }>(`${base}/pulls/${number}`, token);
    type PullFileResponse = {
      filename: string;
      previous_filename?: string;
      status: string;
      additions: number;
      deletions: number;
      changes: number;
      blob_url: string;
      patch?: string;
    };
    const files: PullFileResponse[] = [];
    for (let page = 1; page <= 30 && files.length < pull.changed_files; page += 1) {
      const batch = await this.request<PullFileResponse[]>(
        `${base}/pulls/${number}/files?per_page=100&page=${page}`,
        token,
      );
      files.push(...batch);
      if (batch.length < 100) break;
    }
    return {
      pull: {
        number: pull.number,
        title: pull.title,
        htmlUrl: pull.html_url,
        userLogin: pull.user.login,
        baseSha: pull.base.sha,
        headSha: pull.head.sha,
        changedFiles: pull.changed_files,
      },
      files: files.map((file) => ({
        filename: file.filename,
        previousFilename: file.previous_filename || null,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        blobUrl: file.blob_url,
        patch: file.patch || null,
      })),
    };
  }
}
