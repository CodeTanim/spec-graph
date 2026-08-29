type LogLevel = "info" | "warn" | "error";

export type StructuredLogFields = Record<
  string,
  string | number | boolean | null | undefined
>;

/**
 * Emit one-line JSON logs that Vercel can search by correlation fields.
 * Callers must pass identifiers and safe summaries only, never source content,
 * OAuth tokens, webhook payloads, or provider secrets.
 */
export function structuredLog(
  level: LogLevel,
  event: string,
  fields: StructuredLogFields = {},
): void {
  if (process.env.NODE_ENV === "test" && process.env.SPECGRAPH_TEST_LOGS !== "1") {
    return;
  }

  const record = {
    timestamp: new Date().toISOString(),
    service: "specgraph",
    level,
    event,
    ...Object.fromEntries(
      Object.entries(fields).filter(([, value]) => value !== undefined),
    ),
  };

  try {
    console[level](JSON.stringify(record));
  } catch {
    // Observability must never break the product path it is observing.
  }
}
