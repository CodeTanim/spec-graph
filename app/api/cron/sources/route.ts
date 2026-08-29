import { start } from "workflow/api";
import { ApiError, apiErrorResponse } from "../../../../lib/server/http";
import { structuredLog } from "../../../../lib/observability/structured-log";
import { sourceCadenceWorkflow } from "../../../../workflows/source-cadence";

function authorizeCron(request: Request): void {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    throw new ApiError(503, "CRON_NOT_CONFIGURED", "Scheduled checks are not configured yet.");
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    throw new ApiError(401, "CRON_UNAUTHORIZED", "This scheduled request is not authorized.");
  }
}

export async function GET(request: Request) {
  try {
    authorizeCron(request);
    const run = await start(sourceCadenceWorkflow, []);
    structuredLog("info", "cadence.workflow.dispatched", {
      workflowRunId: run.runId,
      trigger: "scheduled",
    });
    return Response.json({ accepted: true, workflowRunId: run.runId }, { status: 202 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
