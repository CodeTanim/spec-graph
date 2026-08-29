import { and, asc, eq, inArray, lt } from "drizzle-orm";
import { sleep } from "workflow";
import { getDb } from "../db";
import { analysisRuns, sources } from "../db/schema";
import { ConfluenceClient } from "../lib/confluence/client";
import { getConfluenceConfig } from "../lib/confluence/config";
import { checkConfluenceSource } from "../lib/confluence/scheduled";
import { processQueuedGitHubRun } from "../lib/github/webhook";
import {
  bindAnalysisWorkflowStep,
  expireStaleAnalysisRunsStep,
  timeoutAnalysisRunStep,
} from "./analysis-guard";
import { ANALYSIS_RUN_TIMEOUT_DURATION } from "./constants";

export async function sourceCadenceWorkflow() {
  "use workflow";

  await expireStaleAnalysisRunsStep();
  const queuedGitHubRuns = await listQueuedGitHubRunsStep();
  for (const run of queuedGitHubRuns) {
    try {
      await bindAnalysisWorkflowStep(run.workspaceId, run.id);
      const outcome = await Promise.race([
        processQueuedGitHubRunStep(run.id).then(() => "completed" as const),
        sleep(ANALYSIS_RUN_TIMEOUT_DURATION).then(() => "timed_out" as const),
      ]);
      if (outcome === "timed_out") {
        await timeoutAnalysisRunStep(run.workspaceId, run.id);
      }
    } catch {
      // The run stores its own error state. Other queued changes should continue.
    }
  }

  const connectedSources = await listConnectedConfluenceSourcesStep();
  for (const source of connectedSources) {
    try {
      await checkConfluenceSourceStep(source.workspaceId, source.id);
    } catch {
      // The source stores its own error state. Other sources should still run.
    }
  }
}

export async function listQueuedGitHubRunsStep(): Promise<
  Array<{ id: string; workspaceId: string }>
> {
  "use step";

  const runs = await getDb()
    .select({ id: analysisRuns.id, workspaceId: analysisRuns.workspaceId })
    .from(analysisRuns)
    .where(
      and(
        eq(analysisRuns.trigger, "github"),
        inArray(analysisRuns.status, ["queued", "failed"]),
        lt(analysisRuns.attempts, analysisRuns.maxAttempts),
      ),
    )
    .orderBy(asc(analysisRuns.createdAt));
  return runs;
}

export async function processQueuedGitHubRunStep(runId: string) {
  "use step";

  const db = getDb();
  await processQueuedGitHubRun(runId, db);
  const [run] = await db
    .select({ status: analysisRuns.status, errorMessage: analysisRuns.errorMessage })
    .from(analysisRuns)
    .where(eq(analysisRuns.id, runId))
    .limit(1);
  if (run?.status === "failed") {
    throw new Error(run.errorMessage || "GitHub change analysis failed.");
  }
}

processQueuedGitHubRunStep.maxRetries = 2;

export async function listConnectedConfluenceSourcesStep() {
  "use step";

  return getDb()
    .select({ id: sources.id, workspaceId: sources.workspaceId })
    .from(sources)
    .where(
      and(
        eq(sources.provider, "confluence"),
        eq(sources.status, "connected"),
      ),
    );
}

export async function checkConfluenceSourceStep(
  workspaceId: string,
  sourceId: string,
) {
  "use step";

  const config = getConfluenceConfig();
  return checkConfluenceSource(
    workspaceId,
    sourceId,
    config.encryptionKey,
    new ConfluenceClient(config),
  );
}

checkConfluenceSourceStep.maxRetries = 2;
