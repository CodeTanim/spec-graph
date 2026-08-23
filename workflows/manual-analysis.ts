import { and, eq } from "drizzle-orm";
import { getDb } from "../db";
import { analysisRuns } from "../db/schema";
import { executeManualAnalysis } from "../lib/analysis/manual";
import type { StartRunInput } from "../lib/contracts/specgraph";

export async function manualAnalysisWorkflow(
  workspaceId: string,
  analysisRunId: string,
  input: StartRunInput,
) {
  "use workflow";

  await executeManualAnalysisStep(workspaceId, analysisRunId, input);
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
