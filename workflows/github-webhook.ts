import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { analysisRuns } from "../db/schema";
import {
  processGitHubWebhookJob,
  type GitHubWebhookJob,
} from "../lib/github/webhook";

export async function githubWebhookWorkflow(job: GitHubWebhookJob) {
  "use workflow";

  await processGitHubWebhookStep(job);
}

export async function processGitHubWebhookStep(job: GitHubWebhookJob) {
  "use step";

  const db = getDb();
  await processGitHubWebhookJob(job, db);
  const [run] = await db
    .select({ status: analysisRuns.status, errorMessage: analysisRuns.errorMessage })
    .from(analysisRuns)
    .where(eq(analysisRuns.id, job.runId))
    .limit(1);
  if (run?.status === "failed") {
    throw new Error(run.errorMessage ?? "GitHub change analysis failed.");
  }
}

processGitHubWebhookStep.maxRetries = 2;
