import { associateSources } from "../../../lib/providers/source-associations";
import { getRequestWorkspace } from "../../../lib/server/current-workspace";
import { ApiError, apiErrorResponse, readJsonObject } from "../../../lib/server/http";

export async function POST(request: Request) {
  try {
    const { workspace } = await getRequestWorkspace(request);
    const body = await readJsonObject(request);
    const repositorySourceId = typeof body.repositorySourceId === "string" ? body.repositorySourceId : "";
    const documentationSourceId = typeof body.documentationSourceId === "string" ? body.documentationSourceId : "";
    if (!repositorySourceId || !documentationSourceId) {
      throw new ApiError(400, "SOURCE_PAIR_INVALID", "Choose a repository and documentation source.");
    }
    return Response.json(await associateSources(
      workspace.id,
      repositorySourceId,
      documentationSourceId,
    ), { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
