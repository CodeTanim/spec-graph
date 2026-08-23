import { env } from "cloudflare:workers";
import { ApiError } from "../server/http";

export type GitHubOAuthConfig = {
  appSlug: string;
  clientId: string;
  clientSecret: string;
};

export type GitHubAppConfig = GitHubOAuthConfig & {
  appId: string;
  privateKey: string;
};

function value(name: keyof Cloudflare.Env): string {
  const candidate = env[name];
  return typeof candidate === "string" ? candidate.trim() : "";
}

export function getGitHubOAuthConfig(): GitHubOAuthConfig {
  const appSlug = value("GITHUB_APP_SLUG");
  const clientId = value("GITHUB_CLIENT_ID");
  const clientSecret = value("GITHUB_CLIENT_SECRET");

  if (!appSlug || !clientId || !clientSecret) {
    throw new ApiError(
      503,
      "GITHUB_NOT_CONFIGURED",
      "GitHub connection is not configured yet.",
    );
  }

  return { appSlug, clientId, clientSecret };
}

export function getGitHubAppConfig(): GitHubAppConfig {
  const oauth = getGitHubOAuthConfig();
  const appId = value("GITHUB_APP_ID");
  const privateKey = value("GITHUB_PRIVATE_KEY").replace(/\\n/g, "\n");

  if (!appId || !privateKey) {
    throw new ApiError(
      503,
      "GITHUB_NOT_CONFIGURED",
      "GitHub repository access is not configured yet.",
    );
  }

  return { ...oauth, appId, privateKey };
}

export function getGitHubWebhookSecret(): string {
  const secret = value("GITHUB_WEBHOOK_SECRET");
  if (!secret) {
    throw new ApiError(
      503,
      "GITHUB_WEBHOOK_NOT_CONFIGURED",
      "GitHub automatic change detection is not configured yet.",
    );
  }
  return secret;
}
