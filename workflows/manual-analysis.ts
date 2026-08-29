import { and, eq } from "drizzle-orm";
import { sleep } from "workflow";
import { getDb } from "../db";
import { analysisRuns } from "../db/schema";
import { executeManualAnalysis } from "../lib/analysis/manual";
import type { StartRunInput } from "../lib/contracts/specgraph";
import {
  ANALYSIS_RUN_TIMEOUT_DURATION,
  bindAnalysisWorkflowStep,
  timeoutAnalysisRunStep,
} from "./analysis-guard";

export async function manualAnalysisWorkflow(
  workspaceId: string,
  analysisRunId: string,
  input: StartRunInput,
) {
  "use workflow";

  await bindAnalysisWorkflowStep(workspaceId, analysisRunId);
  const outcome = await Promise.race([
    executeManualAnalysisStep(workspaceId, analysisRunId, input).then(
      () => "completed" as const,
    ),
    sleep(ANALYSIS_RUN_TIMEOUT_DURATION).then(() => "timed_out" as const),
  ]);
  if (outcome === "timed_out") {
    await timeoutAnalysisRunStep(workspaceId, analysisRunId);
  }
}

export async function executeManualAnalysisStep(
  workspaceId: string,
  analysisRunId: string,
  input: StartRunInput,
) {
  "use step";

  const db = getDb();
  await executeManualAnalysis(workspaceId, analysisRunId, input, db);
  const [run] = await db
    .select({ status: analysisRuns.status, errorMessage: analysisRuns.errorMessage })
    .from(analysisRuns)
    .where(
      and(
        eq(analysisRuns.id, analysisRunId),
        eq(analysisRuns.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  if (run?.status === "failed") {
    throw new Error(run.errorMessage ?? "Analysis failed.");
  }
}

executeManualAnalysisStep.maxRetries = 2;
