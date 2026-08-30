export const maximumAutomaticAttempts = 3;
export const retryDelaysInSeconds = [30, 120, 600];

export function terminalState(attempt: number) {
  return attempt >= maximumAutomaticAttempts ? "failed" : "retrying";
}
