import { getRequestWorkspace } from "../../../../lib/server/current-workspace";
import { apiErrorResponse } from "../../../../lib/server/http";
import { removeSource } from "../../../../lib/server/specgraph-repository";

type RouteContext = { params: Promise<{ id: string }> };

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const { workspace } = await getRequestWorkspace(request);
    const { id } = await context.params;
    return Response.json(await removeSource(workspace.id, id));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
