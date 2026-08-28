import type { FindingAction } from "../../../../../../lib/contracts/specgraph";
import { getRequestWorkspace } from "../../../../../../lib/server/current-workspace";
import {
  ApiError,
  apiErrorResponse,
  readJsonObject,
} from "../../../../../../lib/server/http";
import { updateFinding } from "../../../../../../lib/server/specgraph-repository";

type RouteContext = {
  params: Promise<{ id: string; findingId: string }>;
};

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const { workspace, user } = await getRequestWorkspace(request);
    const { id, findingId } = await context.params;
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
      item: await updateFinding(
        workspace.id,
        id,
        findingId,
        user.databaseId,
        action as FindingAction,
      ),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
