import { createGitHubConnectionSession } from "../../../../lib/github/connection";
import { getGitHubOAuthConfig } from "../../../../lib/github/config";
import { getRequestWorkspace } from "../../../../lib/server/current-workspace";
import { apiErrorResponse } from "../../../../lib/server/http";

export async function GET(request: Request) {
  try {
    const { workspace, user } = await getRequestWorkspace(request);
    const config = getGitHubOAuthConfig();
    const session = await createGitHubConnectionSession(
      workspace.id,
      user.databaseId,
    );
    const destination = new URL(
      `https://github.com/apps/${encodeURIComponent(config.appSlug)}/installations/new`,
    );
    destination.searchParams.set("state", session.state);
    return Response.redirect(destination, 302);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
