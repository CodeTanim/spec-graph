import { getRequestWorkspace } from "../../../lib/server/current-workspace";
import { ApiError, apiErrorResponse, readJsonObject } from "../../../lib/server/http";
import { createManualRun, listRuns } from "../../../lib/server/specgraph-repository";

export async function GET(request: Request) {
  try {
    const { workspace } = await getRequestWorkspace(request);
    return Response.json(await listRuns(workspace.id));
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const { workspace, user } = await getRequestWorkspace(request);
    const body = await readJsonObject(request);
    const target = typeof body.target === "string" ? body.target : "";
    const sourceId = typeof body.sourceId === "string" ? body.sourceId : undefined;

    if (!target.trim()) {
      throw new ApiError(400, "TARGET_REQUIRED", "Enter something to analyze.");
    }

    const result = await createManualRun(
      workspace.id,
      user.databaseId,
      { target, sourceId },
    );
    return Response.json(result, { status: 202 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
