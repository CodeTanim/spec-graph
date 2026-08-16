import { authorizeGitHubConnectionSession } from "../../../../lib/github/connection";
import { GitHubClient } from "../../../../lib/github/client";
import { getGitHubOAuthConfig } from "../../../../lib/github/config";
import { getRequestWorkspace } from "../../../../lib/server/current-workspace";
import { ApiError } from "../../../../lib/server/http";

function redirectWithError(request: Request, error: unknown): Response {
  const destination = new URL("/", request.url);
  const message =
    error instanceof ApiError
      ? error.message
      : "GitHub connection could not be completed.";
  destination.searchParams.set("github_error", message);
  return Response.redirect(destination, 302);
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const state = url.searchParams.get("state") || "";
    const code = url.searchParams.get("code") || "";
    if (!state || !code) {
      throw new ApiError(
        400,
        "GITHUB_CALLBACK_INVALID",
        "GitHub did not return a complete authorization.",
      );
    }
    const { workspace, user } = await getRequestWorkspace(request);
    const config = getGitHubOAuthConfig();
    const client = new GitHubClient(config);
    const token = await client.exchangeOAuthCode(
      code,
      `${url.origin}/api/github/callback`,
    );
    const candidates = await client.listUserRepositories(token);
    if (!candidates.length) {
      throw new ApiError(
        409,
        "GITHUB_REPOSITORIES_EMPTY",
        "No repositories are available to this GitHub App installation.",
      );
    }
    await authorizeGitHubConnectionSession(
      state,
      workspace.id,
      user.databaseId,
      candidates,
    );
    const destination = new URL("/", request.url);
    destination.searchParams.set("github_session", state);
    return Response.redirect(destination, 302);
  } catch (error) {
    return redirectWithError(request, error);
  }
}
