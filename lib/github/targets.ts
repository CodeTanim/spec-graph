import { ApiError } from "../server/http";

export function parsePullRequestNumber(target: string, repository: string): number {
  const trimmed = target.trim();
  const short = trimmed.match(/^#?(\d+)$/);
  if (short) return Number(short[1]);
  try {
    const url = new URL(trimmed);
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
    if (
      url.hostname === "github.com" &&
      match &&
      `${match[1]}/${match[2]}`.toLowerCase() === repository.toLowerCase()
    ) {
      return Number(match[3]);
    }
  } catch {
    // The target was not a URL.
  }
  throw new ApiError(
    400,
    "PULL_REQUEST_REQUIRED",
    "Enter a pull request number such as #42 or its GitHub URL.",
  );
}
