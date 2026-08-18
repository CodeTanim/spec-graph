import { eq } from "drizzle-orm";
import { getDb, type SpecGraphDb } from "../../db";
import { analysisRuns, runAttempts } from "../../db/schema";
import { ApiError } from "../server/http";

export async function beginRunAttempt(
  runId: string,
  stage: string,
  db: SpecGraphDb = getDb(),
): Promise<string> {
  const now = new Date().toISOString();
  const attemptId = `attempt_${crypto.randomUUID()}`;
  await db
    .update(analysisRuns)
    .set({ status: "running", progress: 10, attempts: 1, startedAt: now, updatedAt: now })
    .where(eq(analysisRuns.id, runId));
  await db.insert(runAttempts).values({
    id: attemptId,
    runId,
    attempt: 1,
    stage,
    status: "running",
    startedAt: now,
  });
  return attemptId;
}

export async function completeRunAttempt(
  runId: string,
  attemptId: string,
  db: SpecGraphDb = getDb(),
): Promise<void> {
  const completedAt = new Date().toISOString();
  await db
    .update(analysisRuns)
    .set({ status: "succeeded", progress: 100, completedAt, updatedAt: completedAt })
    .where(eq(analysisRuns.id, runId));
  await db
    .update(runAttempts)
    .set({ status: "succeeded", finishedAt: completedAt })
    .where(eq(runAttempts.id, attemptId));
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
  const message = error instanceof Error ? error.message : fallbackMessage;
  const code = error instanceof ApiError ? error.code : fallbackCode;
  await db
    .update(analysisRuns)
    .set({
      status: "failed",
      errorCode: code,
      errorMessage: message,
      completedAt: failedAt,
      updatedAt: failedAt,
    })
    .where(eq(analysisRuns.id, runId));
  if (attemptId) {
    await db
      .update(runAttempts)
      .set({ status: "failed", errorCode: code, errorMessage: message, finishedAt: failedAt })
      .where(eq(runAttempts.id, attemptId));
  }
}
