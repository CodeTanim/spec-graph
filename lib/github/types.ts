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

export type GitHubTreeEntry = {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
};

export type GitHubPullRequest = {
  number: number;
  title: string;
  htmlUrl: string;
  userLogin: string;
  baseSha: string;
  headSha: string;
  changedFiles: number;
};

export type GitHubPullFile = {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  blobUrl: string;
};
