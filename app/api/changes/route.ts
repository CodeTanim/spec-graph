import { getRequestWorkspace } from "../../../lib/server/current-workspace";
import { apiErrorResponse } from "../../../lib/server/http";
import { listChanges } from "../../../lib/server/specgraph-repository";

export async function GET(request: Request) {
  try {
    const { workspace } = await getRequestWorkspace(request);
    const requestedStatus = new URL(request.url).searchParams.get("status");
    const filter = requestedStatus === "all" ? "all" : "open";
    return Response.json(await listChanges(workspace.id, filter));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
