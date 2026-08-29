import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { getDb, type SpecGraphDb } from "../../db";
import { analysisRuns, runAttempts } from "../../db/schema";
import { ApiError } from "../server/http";

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
  return attemptId;
}

export async function completeRunAttempt(
  runId: string,
  attemptId: string,
  db: SpecGraphDb = getDb(),
): Promise<void> {
  const completedAt = new Date().toISOString();
  const [attempt] = await db
    .select({ attempt: runAttempts.attempt })
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
        .select({ attempt: runAttempts.attempt })
        .from(runAttempts)
        .where(and(eq(runAttempts.id, attemptId), eq(runAttempts.runId, runId)))
        .limit(1)
    : [];
  await db
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
    );
  if (attemptId) {
    await db
      .update(runAttempts)
      .set({ status: "failed", errorCode: code, errorMessage: message, finishedAt: failedAt })
      .where(and(eq(runAttempts.id, attemptId), eq(runAttempts.status, "running")));
  }
}
