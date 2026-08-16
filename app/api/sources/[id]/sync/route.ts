import { GitHubClient } from "../../../../../lib/github/client";
import { getGitHubAppConfig } from "../../../../../lib/github/config";
import { syncGitHubSource } from "../../../../../lib/github/ingestion";
import { getRequestWorkspace } from "../../../../../lib/server/current-workspace";
import { apiErrorResponse } from "../../../../../lib/server/http";
import { getSource } from "../../../../../lib/server/specgraph-repository";
import { ConfluenceClient } from "../../../../../lib/confluence/client";
import { getConfluenceConfig } from "../../../../../lib/confluence/config";
import { syncConfluenceSource } from "../../../../../lib/confluence/ingestion";
import { rebuildCrossSourceRelationships } from "../../../../../lib/providers/cross-source-relationships";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    const { workspace } = await getRequestWorkspace(request);
    const { id } = await context.params;
    const source = await getSource(workspace.id, id);
    if (source.provider === "github") {
      await syncGitHubSource(workspace.id, id, new GitHubClient(getGitHubAppConfig()));
    } else {
      const config = getConfluenceConfig();
      await syncConfluenceSource(
        workspace.id,
        id,
        config.encryptionKey,
        new ConfluenceClient(config),
      );
    }
    await rebuildCrossSourceRelationships(workspace.id, id);
    return Response.json({ source: await getSource(workspace.id, id) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
