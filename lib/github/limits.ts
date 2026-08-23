import { ApiError } from "../server/http";

const MAX_FILES = 120;
const MAX_TOTAL_BYTES = 4_000_000;

export function assertRepositoryWithinLimits(
  entries: Array<{ size?: number | null }>,
): void {
  if (entries.length > MAX_FILES) {
    throw new ApiError(
      413,
      "REPOSITORY_FILE_LIMIT",
      `This MVP indexes up to ${MAX_FILES} supported files per repository.`,
    );
  }
  const totalBytes = entries.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new ApiError(
      413,
      "REPOSITORY_SIZE_LIMIT",
      "The supported files in this repository exceed the current MVP size limit.",
    );
  }
}
