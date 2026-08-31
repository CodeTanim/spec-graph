import { and, lt, ne } from "drizzle-orm";
import { getDb, type SpecGraphDb } from "../../db";
import { changeEvents } from "../../db/schema";

export const ANALYSIS_SCOPE_RETENTION_DAYS = 30;

/**
 * Raw before/after snippets are retry inputs, not permanent product history.
 * Findings keep their reviewed evidence separately, so old private scopes can
 * be redacted without changing the feed or review record.
 */
export async function pruneExpiredAnalysisScopes(
  now = new Date(),
  db: SpecGraphDb = getDb(),
): Promise<number> {
  const cutoff = new Date(
    now.valueOf() - ANALYSIS_SCOPE_RETENTION_DAYS * 24 * 60 * 60 * 1_000,
  ).toISOString();
  const redacted = await db
    .update(changeEvents)
    .set({ analysisScopeJson: "[]" })
    .where(
      and(
        lt(changeEvents.createdAt, cutoff),
        ne(changeEvents.analysisScopeJson, "[]"),
      ),
    )
    .returning({ id: changeEvents.id });
  return redacted.length;
}
