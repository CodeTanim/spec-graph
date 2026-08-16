import type {
  GitHubPullFile,
  GitHubPullRequest,
  GitHubRepositoryCandidate,
  GitHubTreeEntry,
} from "../github/types";

export interface GitHubSourceProvider {
  readonly provider: "github";
  exchangeOAuthCode(code: string, redirectUri: string): Promise<string>;
  listUserRepositories(userToken: string): Promise<GitHubRepositoryCandidate[]>;
  branchRevision(
    installationId: string,
    fullName: string,
    branch: string,
  ): Promise<string>;
  repositoryTree(
    installationId: string,
    fullName: string,
    revision: string,
  ): Promise<{ entries: GitHubTreeEntry[]; truncated: boolean; token: string }>;
  blob(fullName: string, sha: string, token: string): Promise<string>;
  pullRequest(
    installationId: string,
    fullName: string,
    number: number,
  ): Promise<{ pull: GitHubPullRequest; files: GitHubPullFile[] }>;
}
