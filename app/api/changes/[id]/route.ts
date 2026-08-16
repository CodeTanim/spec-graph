import type { FindingAction } from "../../../../lib/contracts/specgraph";
import { getRequestWorkspace } from "../../../../lib/server/current-workspace";
import { ApiError, apiErrorResponse, readJsonObject } from "../../../../lib/server/http";
import { getChange, updateChange } from "../../../../lib/server/specgraph-repository";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    const { workspace } = await getRequestWorkspace(request);
    const { id } = await context.params;
    return Response.json({ item: await getChange(workspace.id, id) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const { workspace, user } = await getRequestWorkspace(request);
    const { id } = await context.params;
    const body = await readJsonObject(request);
    const action = body.action;

    if (action !== "dismiss" && action !== "resolve" && action !== "reopen") {
      throw new ApiError(
        400,
        "INVALID_ACTION",
        "Choose dismiss, resolve, or reopen.",
      );
    }

    return Response.json({
      item: await updateChange(
        workspace.id,
        id,
        user.databaseId,
        action as FindingAction,
      ),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
