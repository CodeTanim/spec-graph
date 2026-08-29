import { and, eq } from "drizzle-orm";
import { getDb } from "../db";
import { analysisRuns } from "../db/schema";
import { executeManualAnalysis } from "../lib/analysis/manual";
import { analyzePendingConfluenceChanges } from "../lib/confluence/scheduled";
import { processQueuedGitHubRun } from "../lib/github/webhook";

export async function retryAnalysisWorkflow(
  workspaceId: string,
  analysisRunId: string,
) {
  "use workflow";

  await retryAnalysisStep(workspaceId, analysisRunId);
}

export async function retryAnalysisStep(
  workspaceId: string,
  analysisRunId: string,
) {
  "use step";

  const db = getDb();
  const [run] = await db
    .select({
      sourceId: analysisRuns.sourceId,
      target: analysisRuns.target,
      trigger: analysisRuns.trigger,
    })
    .from(analysisRuns)
    .where(
      and(
        eq(analysisRuns.id, analysisRunId),
        eq(analysisRuns.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  if (!run) throw new Error("The analysis run no longer exists.");

  if (run.trigger === "github") {
    await processQueuedGitHubRun(analysisRunId, db);
  } else if (run.trigger === "scheduled") {
    if (!run.sourceId) throw new Error("The documentation source is no longer connected.");
    await analyzePendingConfluenceChanges(workspaceId, run.sourceId, db);
  } else {
    await executeManualAnalysis(
      workspaceId,
      analysisRunId,
      { target: run.target, sourceId: run.sourceId || undefined },
      db,
    );
  }

  const [updated] = await db
    .select({ status: analysisRuns.status, errorMessage: analysisRuns.errorMessage })
    .from(analysisRuns)
    .where(
      and(
        eq(analysisRuns.id, analysisRunId),
        eq(analysisRuns.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  if (updated?.status === "failed") {
    throw new Error(updated.errorMessage || "Analysis failed.");
  }
}

retryAnalysisStep.maxRetries = 2;
