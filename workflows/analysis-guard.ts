import { getStepMetadata, getWorkflowMetadata } from "workflow";
import {
  ANALYSIS_RUN_TIMEOUT_MS,
  bindRunToWorkflow,
  expireStaleAnalysisRuns,
  timeoutRunningAnalysisRun,
} from "../lib/analysis/run-lifecycle";
import { structuredLog } from "../lib/observability/structured-log";

export { ANALYSIS_RUN_TIMEOUT_DURATION } from "../lib/analysis/run-lifecycle";

export async function bindAnalysisWorkflowStep(
  workspaceId: string,
  runId: string,
): Promise<void> {
  "use step";

  const workflow = getWorkflowMetadata();
  const step = getStepMetadata();
  await bindRunToWorkflow(workspaceId, runId, workflow.workflowRunId);
  structuredLog("info", "analysis.workflow.step_started", {
    runId,
    workspaceId,
    workflowRunId: workflow.workflowRunId,
    workflowStepId: step.stepId,
    workflowStepAttempt: step.attempt,
  });
}

bindAnalysisWorkflowStep.maxRetries = 2;

export async function timeoutAnalysisRunStep(
  workspaceId: string,
  runId: string,
): Promise<void> {
  "use step";

  const workflow = getWorkflowMetadata();
  await bindRunToWorkflow(workspaceId, runId, workflow.workflowRunId);
  await timeoutRunningAnalysisRun(
    workspaceId,
    runId,
    ANALYSIS_RUN_TIMEOUT_MS,
  );
}

timeoutAnalysisRunStep.maxRetries = 2;

export async function expireStaleAnalysisRunsStep(): Promise<number> {
  "use step";

  return expireStaleAnalysisRuns();
}

expireStaleAnalysisRunsStep.maxRetries = 2;
