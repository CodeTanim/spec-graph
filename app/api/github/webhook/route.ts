import { eq } from "drizzle-orm";
import { start } from "workflow/api";
import { getDb } from "../../../../db";
import { analysisRuns } from "../../../../db/schema";
import { acceptGitHubWebhook, verifyGitHubWebhookSignature } from "../../../../lib/github/webhook";
import { getGitHubWebhookSecret } from "../../../../lib/github/config";
import { ApiError, apiErrorResponse } from "../../../../lib/server/http";
import { githubWebhookWorkflow } from "../../../../workflows/github-webhook";

const MAX_WEBHOOK_BYTES = 2_000_000;

export async function POST(request: Request) {
  try {
    const deliveryId = request.headers.get("x-github-delivery")?.trim();
    const eventType = request.headers.get("x-github-event")?.trim();
    if (!deliveryId || !eventType) {
      throw new ApiError(400, "GITHUB_WEBHOOK_HEADERS_REQUIRED", "GitHub delivery headers are required.");
    }
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > MAX_WEBHOOK_BYTES) {
      throw new ApiError(413, "GITHUB_WEBHOOK_TOO_LARGE", "The GitHub webhook payload is too large.");
    }
    const payload = new Uint8Array(await request.arrayBuffer());
    if (payload.byteLength > MAX_WEBHOOK_BYTES) {
      throw new ApiError(413, "GITHUB_WEBHOOK_TOO_LARGE", "The GitHub webhook payload is too large.");
    }
    const valid = await verifyGitHubWebhookSignature(
      payload,
      request.headers.get("x-hub-signature-256"),
      getGitHubWebhookSecret(),
    );
    if (!valid) {
      throw new ApiError(401, "GITHUB_WEBHOOK_SIGNATURE_INVALID", "GitHub webhook signature is invalid.");
    }
    const accepted = await acceptGitHubWebhook(deliveryId, eventType, payload);
    if (accepted.job) {
      const workflowRun = await start(githubWebhookWorkflow, [accepted.job]);
      await getDb()
        .update(analysisRuns)
        .set({ workflowRunId: workflowRun.runId })
        .where(eq(analysisRuns.id, accepted.job.runId));
    }
    return Response.json(accepted.body, { status: accepted.status });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
