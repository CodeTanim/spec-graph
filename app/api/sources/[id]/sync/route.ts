import { GitHubClient } from "../../../../../lib/github/client";
import { getGitHubAppConfig } from "../../../../../lib/github/config";
import { syncGitHubSource } from "../../../../../lib/github/ingestion";
import { getRequestWorkspace } from "../../../../../lib/server/current-workspace";
import { apiErrorResponse } from "../../../../../lib/server/http";
import { getSource } from "../../../../../lib/server/specgraph-repository";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    const { workspace } = await getRequestWorkspace(request);
    const { id } = await context.params;
    const client = new GitHubClient(getGitHubAppConfig());
    await syncGitHubSource(workspace.id, id, client);
    return Response.json({ source: await getSource(workspace.id, id) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
