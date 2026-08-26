import { createGitHubConnectionSession } from "../../../../lib/github/connection";
import { getGitHubOAuthConfig } from "../../../../lib/github/config";
import { getRequestWorkspace } from "../../../../lib/server/current-workspace";
import { apiErrorResponse } from "../../../../lib/server/http";

export async function GET(request: Request) {
  try {
    const { workspace, user } = await getRequestWorkspace(request);
    const sourceGroupId = new URL(request.url).searchParams.get("group_id");
    const config = getGitHubOAuthConfig();
    const session = await createGitHubConnectionSession(
      workspace.id,
      user.databaseId,
      sourceGroupId,
    );
    const destination = new URL("https://github.com/login/oauth/authorize");
    destination.searchParams.set("client_id", config.clientId);
    destination.searchParams.set(
      "redirect_uri",
      `${new URL(request.url).origin}/api/github/callback`,
    );
    destination.searchParams.set("state", session.state);
    return Response.redirect(destination, 302);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
