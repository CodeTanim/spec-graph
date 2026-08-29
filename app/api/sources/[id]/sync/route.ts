import { getRequestWorkspace } from "../../../../../lib/server/current-workspace";
import { apiErrorResponse } from "../../../../../lib/server/http";
import { getSource } from "../../../../../lib/server/specgraph-repository";
import { sourceSyncWorkflow } from "../../../../../workflows/source-sync";
import { start } from "workflow/api";
import { structuredLog } from "../../../../../lib/observability/structured-log";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    const { workspace } = await getRequestWorkspace(request);
    const { id } = await context.params;
    const source = await getSource(workspace.id, id);
    const run = await start(sourceSyncWorkflow, [workspace.id, source.id]);
    structuredLog("info", "source_sync.workflow.dispatched", {
      workspaceId: workspace.id,
      sourceId: source.id,
      workflowRunId: run.runId,
      provider: source.provider,
    });
    return Response.json({ source }, { status: 202 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
