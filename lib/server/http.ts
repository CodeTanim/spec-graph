import type { ApiErrorBody } from "../contracts/specgraph";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function apiErrorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    return Response.json(
      { error: { code: error.code, message: error.message } } satisfies ApiErrorBody,
      { status: error.status },
    );
  }

  const message = error instanceof Error ? error.message : "Unexpected error";
  const databaseUnavailable =
    message.includes("no such table") || message.includes("D1 binding `DB` is unavailable");

  return Response.json(
    {
      error: {
        code: databaseUnavailable ? "DATABASE_NOT_READY" : "INTERNAL_ERROR",
        message: databaseUnavailable
          ? "SpecGraph storage is being prepared. Please try again shortly."
          : "SpecGraph could not complete that request.",
      },
    } satisfies ApiErrorBody,
    { status: 500 },
  );
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("not an object");
    }
    return value as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "INVALID_JSON", "The request body must be valid JSON.");
  }
}
