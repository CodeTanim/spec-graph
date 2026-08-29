import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { getDb, type SpecGraphDb } from "../../db";
import {
  analysisRuns,
  runAttempts,
  webhookDeliveries,
} from "../../db/schema";
import { structuredLog } from "../observability/structured-log";
import { ApiError } from "../server/http";

export const ANALYSIS_RUN_TIMEOUT_DURATION = "10m";
export const ANALYSIS_RUN_TIMEOUT_MS = 10 * 60 * 1_000;

type RunLogContext = {
  runId: string;
  workspaceId: string;
  sourceId: string | null;
  workflowRunId: string | null;
  providerDeliveryId: string | null;
  attempt: number;
  maxAttempts: number;
};

async function runLogContext(
  runId: string,
  db: SpecGraphDb,
): Promise<RunLogContext | null> {
  const [context] = await db
    .select({
      runId: analysisRuns.id,
      workspaceId: analysisRuns.workspaceId,
      sourceId: analysisRuns.sourceId,
      workflowRunId: analysisRuns.workflowRunId,
      providerDeliveryId: webhookDeliveries.providerDeliveryId,
      attempt: analysisRuns.attempts,
      maxAttempts: analysisRuns.maxAttempts,
    })
    .from(analysisRuns)
    .leftJoin(
      webhookDeliveries,
      eq(webhookDeliveries.analysisRunId, analysisRuns.id),
    )
    .where(eq(analysisRuns.id, runId))
    .limit(1);
  return context || null;
}

function logRunEvent(
  level: "info" | "warn" | "error",
  event: string,
  context: RunLogContext,
  fields: Record<string, string | number | boolean | null | undefined> = {},
): void {
  structuredLog(level, event, {
    runId: context.runId,
    workspaceId: context.workspaceId,
    sourceId: context.sourceId,
    workflowRunId: context.workflowRunId,
    providerDeliveryId: context.providerDeliveryId,
    attempt: context.attempt,
    maxAttempts: context.maxAttempts,
    ...fields,
  });
}

export async function bindRunToWorkflow(
  workspaceId: string,
  runId: string,
  workflowRunId: string,
  db: SpecGraphDb = getDb(),
): Promise<void> {
  const [bound] = await db
    .update(analysisRuns)
    .set({ workflowRunId, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(analysisRuns.id, runId),
        eq(analysisRuns.workspaceId, workspaceId),
      ),
    )
    .returning({ id: analysisRuns.id });
  if (!bound) return;
  const context = await runLogContext(runId, db);
  if (context) logRunEvent("info", "analysis.workflow.bound", context);
}

export async function beginRunAttempt(
  runId: string,
  stage: string,
  db: SpecGraphDb = getDb(),
): Promise<string | null> {
  const now = new Date().toISOString();
  const attemptId = `attempt_${crypto.randomUUID()}`;
  const claimed = await db
    .update(analysisRuns)
    .set({
      status: "running",
      progress: 10,
      attempts: sql`${analysisRuns.attempts} + 1`,
      errorCode: null,
      errorMessage: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(analysisRuns.id, runId),
        inArray(analysisRuns.status, ["queued", "failed"]),
        lt(analysisRuns.attempts, analysisRuns.maxAttempts),
      ),
    )
    .returning({ id: analysisRuns.id, attempt: analysisRuns.attempts });
  if (!claimed.length) return null;
  await db.insert(runAttempts).values({
    id: attemptId,
    runId,
    attempt: claimed[0].attempt,
    stage,
    status: "running",
    startedAt: now,
  });
  const context = await runLogContext(runId, db);
  if (context) {
    logRunEvent("info", "analysis.attempt.started", context, {
      attemptId,
      stage,
    });
  }
  return attemptId;
}

export async function completeRunAttempt(
  runId: string,
  attemptId: string,
  db: SpecGraphDb = getDb(),
): Promise<void> {
  const completedAt = new Date().toISOString();
  const [attempt] = await db
    .select({ attempt: runAttempts.attempt, startedAt: runAttempts.startedAt })
    .from(runAttempts)
    .where(and(eq(runAttempts.id, attemptId), eq(runAttempts.runId, runId)))
    .limit(1);
  if (!attempt) return;
  const completed = await db
    .update(analysisRuns)
    .set({ status: "succeeded", progress: 100, completedAt, updatedAt: completedAt })
    .where(
      and(
        eq(analysisRuns.id, runId),
        eq(analysisRuns.status, "running"),
        eq(analysisRuns.attempts, attempt.attempt),
      ),
    )
    .returning({ id: analysisRuns.id });
  if (!completed.length) return;
  await db
    .update(runAttempts)
    .set({ status: "succeeded", finishedAt: completedAt })
    .where(and(eq(runAttempts.id, attemptId), eq(runAttempts.status, "running")));
  const context = await runLogContext(runId, db);
  if (context) {
    logRunEvent("info", "analysis.attempt.succeeded", context, {
      attemptId,
      durationMs: Math.max(
        0,
        new Date(completedAt).valueOf() - new Date(attempt.startedAt).valueOf(),
      ),
      status: "succeeded",
    });
  }
}

export async function failRunAttempt(
  runId: string,
  attemptId: string | null,
  error: unknown,
  fallbackCode: string,
  fallbackMessage: string,
  db: SpecGraphDb = getDb(),
): Promise<void> {
  const failedAt = new Date().toISOString();
  const message = error instanceof ApiError ? error.message : fallbackMessage;
  const code = error instanceof ApiError ? error.code : fallbackCode;
  const [attempt] = attemptId
    ? await db
        .select({ attempt: runAttempts.attempt, startedAt: runAttempts.startedAt })
        .from(runAttempts)
        .where(and(eq(runAttempts.id, attemptId), eq(runAttempts.runId, runId)))
        .limit(1)
    : [];
  const failed = await db
    .update(analysisRuns)
    .set({
      status: "failed",
      errorCode: code,
      errorMessage: message,
      completedAt: failedAt,
      updatedAt: failedAt,
    })
    .where(
      attempt
        ? and(
            eq(analysisRuns.id, runId),
            eq(analysisRuns.status, "running"),
            eq(analysisRuns.attempts, attempt.attempt),
          )
        : and(
            eq(analysisRuns.id, runId),
            inArray(analysisRuns.status, ["queued", "running", "failed"]),
      ),
    )
    .returning({ id: analysisRuns.id });
  if (attemptId) {
    await db
      .update(runAttempts)
      .set({ status: "failed", errorCode: code, errorMessage: message, finishedAt: failedAt })
      .where(and(eq(runAttempts.id, attemptId), eq(runAttempts.status, "running")));
  }
  if (!failed.length) return;
  const context = await runLogContext(runId, db);
  if (context) {
    logRunEvent("error", "analysis.attempt.failed", context, {
      attemptId,
      errorCode: code,
      errorType: error instanceof Error ? error.name : "UnknownError",
      durationMs: attempt?.startedAt
        ? Math.max(
            0,
            new Date(failedAt).valueOf() - new Date(attempt.startedAt).valueOf(),
          )
        : undefined,
      terminal: context.attempt >= context.maxAttempts,
      status: "failed",
    });
  }
}

async function markTimedOutRun(
  run: {
    id: string;
    workspaceId: string;
    attempts: number;
    startedAt: string | null;
  },
  timeoutMs: number,
  timedOutAt: string,
  db: SpecGraphDb,
): Promise<boolean> {
  const timeoutMinutes = Math.max(1, Math.round(timeoutMs / 60_000));
  const timeoutLabel = `${timeoutMinutes} ${timeoutMinutes === 1 ? "minute" : "minutes"}`;
  const errorMessage = `Analysis timed out after ${timeoutLabel}. Retry the check.`;
  const [updated] = await db
    .update(analysisRuns)
    .set({
      status: "failed",
      errorCode: "ANALYSIS_TIMEOUT",
      errorMessage,
      completedAt: timedOutAt,
      updatedAt: timedOutAt,
    })
    .where(
      and(
        eq(analysisRuns.id, run.id),
        eq(analysisRuns.workspaceId, run.workspaceId),
        eq(analysisRuns.status, "running"),
        eq(analysisRuns.attempts, run.attempts),
      ),
    )
    .returning({ id: analysisRuns.id });
  if (!updated) return false;

  await db
    .update(runAttempts)
    .set({
      status: "failed",
      errorCode: "ANALYSIS_TIMEOUT",
      errorMessage,
      finishedAt: timedOutAt,
    })
    .where(
      and(
        eq(runAttempts.runId, run.id),
        eq(runAttempts.attempt, run.attempts),
        eq(runAttempts.status, "running"),
      ),
    );
  const context = await runLogContext(run.id, db);
  if (context) {
    logRunEvent("error", "analysis.attempt.timed_out", context, {
      errorCode: "ANALYSIS_TIMEOUT",
      durationMs: run.startedAt
        ? Math.max(
            0,
            new Date(timedOutAt).valueOf() - new Date(run.startedAt).valueOf(),
          )
        : timeoutMs,
      terminal: context.attempt >= context.maxAttempts,
      status: "failed",
    });
  }
  return true;
}

export async function timeoutRunningAnalysisRun(
  workspaceId: string,
  runId: string,
  timeoutMs: number = ANALYSIS_RUN_TIMEOUT_MS,
  db: SpecGraphDb = getDb(),
): Promise<boolean> {
  const [run] = await db
    .select({
      id: analysisRuns.id,
      workspaceId: analysisRuns.workspaceId,
      attempts: analysisRuns.attempts,
      startedAt: analysisRuns.startedAt,
    })
    .from(analysisRuns)
    .where(
      and(
        eq(analysisRuns.id, runId),
        eq(analysisRuns.workspaceId, workspaceId),
        eq(analysisRuns.status, "running"),
      ),
    )
    .limit(1);
  if (!run) return false;
  return markTimedOutRun(run, timeoutMs, new Date().toISOString(), db);
}

export async function expireStaleAnalysisRuns(
  options: {
    workspaceId?: string;
    timeoutMs?: number;
    now?: Date;
  } = {},
  db: SpecGraphDb = getDb(),
): Promise<number> {
  const timeoutMs = options.timeoutMs ?? ANALYSIS_RUN_TIMEOUT_MS;
  const now = options.now ?? new Date();
  const cutoff = new Date(now.valueOf() - timeoutMs).toISOString();
  const runs = await db
    .select({
      id: analysisRuns.id,
      workspaceId: analysisRuns.workspaceId,
      attempts: analysisRuns.attempts,
      startedAt: analysisRuns.startedAt,
    })
    .from(analysisRuns)
    .where(
      options.workspaceId
        ? and(
            eq(analysisRuns.workspaceId, options.workspaceId),
            eq(analysisRuns.status, "running"),
            lt(analysisRuns.startedAt, cutoff),
          )
        : and(
            eq(analysisRuns.status, "running"),
            lt(analysisRuns.startedAt, cutoff),
          ),
    );

  let expired = 0;
  for (const run of runs) {
    if (await markTimedOutRun(run, timeoutMs, now.toISOString(), db)) expired += 1;
  }
  return expired;
}
