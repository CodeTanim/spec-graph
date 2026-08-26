import { connectConfluenceSource } from "../../../../lib/confluence/source-service";
import { getRequestWorkspace } from "../../../../lib/server/current-workspace";
import { ApiError, apiErrorResponse, readJsonObject } from "../../../../lib/server/http";
import { sourceSyncWorkflow } from "../../../../workflows/source-sync";
import { start } from "workflow/api";

export async function POST(request: Request) {
  try {
    const { workspace, user } = await getRequestWorkspace(request);
    const body = await readJsonObject(request);
    const sessionState = typeof body.sessionState === "string" ? body.sessionState : "";
    const spaceId = typeof body.spaceId === "string" ? body.spaceId : "";
    if (!sessionState || !spaceId) {
      throw new ApiError(400, "CONFLUENCE_SOURCE_INVALID", "Choose a Confluence space.");
    }
    const result = await connectConfluenceSource(
      workspace.id,
      user.databaseId,
      { sessionState, spaceId },
    );
    await start(sourceSyncWorkflow, [workspace.id, result.source.id]);
    return Response.json(result, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
