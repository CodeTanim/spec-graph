import { getRequestWorkspace } from "../../../../../lib/server/current-workspace";
import { apiErrorResponse } from "../../../../../lib/server/http";
import { getSource } from "../../../../../lib/server/specgraph-repository";
import { sourceSyncWorkflow } from "../../../../../workflows/source-sync";
import { start } from "workflow/api";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    const { workspace } = await getRequestWorkspace(request);
    const { id } = await context.params;
    const source = await getSource(workspace.id, id);
    await start(sourceSyncWorkflow, [workspace.id, source.id]);
    return Response.json({ source }, { status: 202 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
