import { and, eq } from "drizzle-orm";
import { start } from "workflow/api";
import { getDb } from "../../../../../db";
import { analysisRuns } from "../../../../../db/schema";
import { failRunAttempt } from "../../../../../lib/analysis/run-lifecycle";
import { getRequestWorkspace } from "../../../../../lib/server/current-workspace";
import { ApiError, apiErrorResponse } from "../../../../../lib/server/http";
import {
  getRun,
  retryFailedRun,
} from "../../../../../lib/server/specgraph-repository";
import { retryAnalysisWorkflow } from "../../../../../workflows/retry-analysis";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    const { workspace, user } = await getRequestWorkspace(request);
    const { id } = await context.params;
    await retryFailedRun(workspace.id, id, user.databaseId);

    let workflowRun;
    try {
      workflowRun = await start(retryAnalysisWorkflow, [workspace.id, id]);
    } catch {
      await failRunAttempt(
        id,
        null,
        new ApiError(503, "RETRY_DISPATCH_FAILED", "The retry could not be started."),
        "RETRY_DISPATCH_FAILED",
        "The retry could not be started.",
      );
      throw new ApiError(
        503,
        "RETRY_DISPATCH_FAILED",
        "The retry could not be started.",
      );
    }
    await getDb()
      .update(analysisRuns)
      .set({ workflowRunId: workflowRun.runId })
      .where(
        and(
          eq(analysisRuns.id, id),
          eq(analysisRuns.workspaceId, workspace.id),
        ),
      );

    return Response.json({ run: await getRun(workspace.id, id) }, { status: 202 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
