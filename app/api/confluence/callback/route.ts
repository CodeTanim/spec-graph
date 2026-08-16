import { ConfluenceClient } from "../../../../lib/confluence/client";
import {
  authorizeConfluenceConnectionSession,
  hasAuthorizedConfluenceConnectionSession,
} from "../../../../lib/confluence/connection";
import { getConfluenceConfig } from "../../../../lib/confluence/config";
import { getRequestWorkspace } from "../../../../lib/server/current-workspace";
import { ApiError } from "../../../../lib/server/http";

function redirectWithError(request: Request, error: unknown): Response {
  const destination = new URL("/", request.url);
  destination.searchParams.set(
    "confluence_error",
    error instanceof ApiError ? error.message : "Confluence connection could not be completed.",
  );
  return Response.redirect(destination, 302);
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const state = url.searchParams.get("state") || "";
    const code = url.searchParams.get("code") || "";
    if (!state || !code) {
      throw new ApiError(400, "CONFLUENCE_CALLBACK_INVALID", "Confluence did not return a complete authorization.");
    }
    const { workspace, user } = await getRequestWorkspace(request);
    if (await hasAuthorizedConfluenceConnectionSession(
      state,
      workspace.id,
      user.databaseId,
    )) {
      const destination = new URL("/", request.url);
      destination.searchParams.set("confluence_session", state);
      return Response.redirect(destination, 302);
    }
    const config = getConfluenceConfig();
    const client = new ConfluenceClient(config);
    const token = await client.exchangeOAuthCode(code, `${url.origin}/api/confluence/callback`);
    const accessible = (await client.accessibleResources(token.accessToken)).filter((resource) =>
      resource.scopes.some((scope) => scope.includes("confluence")),
    );
    const resources = await Promise.all(accessible.map(async (resource) => ({
      resource,
      spaces: await client.spaces(token.accessToken, resource.id),
    })));
    if (!resources.some((item) => item.spaces.length)) {
      throw new ApiError(409, "CONFLUENCE_SPACES_EMPTY", "No readable Confluence spaces are available.");
    }
    await authorizeConfluenceConnectionSession(
      state,
      workspace.id,
      user.databaseId,
      token,
      resources,
      config.encryptionKey,
    );
    const destination = new URL("/", request.url);
    destination.searchParams.set("confluence_session", state);
    return Response.redirect(destination, 302);
  } catch (error) {
    return redirectWithError(request, error);
  }
}
