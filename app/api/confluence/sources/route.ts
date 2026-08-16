import { ConfluenceClient } from "../../../../lib/confluence/client";
import { getConfluenceConfig } from "../../../../lib/confluence/config";
import { connectConfluenceSource } from "../../../../lib/confluence/source-service";
import { getRequestWorkspace } from "../../../../lib/server/current-workspace";
import { ApiError, apiErrorResponse, readJsonObject } from "../../../../lib/server/http";

export async function POST(request: Request) {
  try {
    const { workspace, user } = await getRequestWorkspace(request);
    const body = await readJsonObject(request);
    const sessionState = typeof body.sessionState === "string" ? body.sessionState : "";
    const spaceId = typeof body.spaceId === "string" ? body.spaceId : "";
    const repositorySourceId = typeof body.repositorySourceId === "string" ? body.repositorySourceId : undefined;
    if (!sessionState || !spaceId) {
      throw new ApiError(400, "CONFLUENCE_SOURCE_INVALID", "Choose a Confluence space.");
    }
    const config = getConfluenceConfig();
    return Response.json(await connectConfluenceSource(
      workspace.id,
      user.databaseId,
      { sessionState, spaceId, repositorySourceId },
      config.encryptionKey,
      new ConfluenceClient(config),
    ), { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
