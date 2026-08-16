import { getRequestWorkspace } from "../../../lib/server/current-workspace";
import { apiErrorResponse } from "../../../lib/server/http";
import { listSources } from "../../../lib/server/specgraph-repository";

export async function GET(request: Request) {
  try {
    const { workspace } = await getRequestWorkspace(request);
    return Response.json(await listSources(workspace.id));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
