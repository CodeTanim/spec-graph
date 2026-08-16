import { createConfluenceConnectionSession } from "../../../../lib/confluence/connection";
import { CONFLUENCE_SCOPES, getConfluenceConfig } from "../../../../lib/confluence/config";
import { getRequestWorkspace } from "../../../../lib/server/current-workspace";
import { apiErrorResponse } from "../../../../lib/server/http";

export async function GET(request: Request) {
  try {
    const { workspace, user } = await getRequestWorkspace(request);
    const config = getConfluenceConfig();
    const repositorySourceId = new URL(request.url).searchParams.get("repository_source_id");
    const session = await createConfluenceConnectionSession(
      workspace.id,
      user.databaseId,
      repositorySourceId,
    );
    const destination = new URL("https://auth.atlassian.com/authorize");
    destination.searchParams.set("audience", "api.atlassian.com");
    destination.searchParams.set("client_id", config.clientId);
    destination.searchParams.set("scope", CONFLUENCE_SCOPES);
    destination.searchParams.set("redirect_uri", `${new URL(request.url).origin}/api/confluence/callback`);
    destination.searchParams.set("state", session.state);
    destination.searchParams.set("response_type", "code");
    destination.searchParams.set("prompt", "consent");
    return Response.redirect(destination, 302);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
