import { connectSources } from "../../../lib/providers/source-groups";
import { rebuildCrossSourceRelationships } from "../../../lib/providers/cross-source-relationships";
import { getRequestWorkspace } from "../../../lib/server/current-workspace";
import { ApiError, apiErrorResponse, readJsonObject } from "../../../lib/server/http";

export async function POST(request: Request) {
  try {
    const { workspace } = await getRequestWorkspace(request);
    const body = await readJsonObject(request);
    const sourceIds = Array.isArray(body.sourceIds)
      ? body.sourceIds.filter((value): value is string => typeof value === "string")
      : [];
    if (sourceIds.length < 2) {
      throw new ApiError(
        400,
        "SOURCE_GROUP_INVALID",
        "Choose at least two different sources.",
      );
    }
    const result = await connectSources(workspace.id, sourceIds);
    await rebuildCrossSourceRelationships(workspace.id, sourceIds[0]);
    return Response.json(result, {
      status: 201,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
