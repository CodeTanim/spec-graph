export type ReviewDecision = "open" | "resolved" | "dismissed";

export function preserveReviewDecision(fingerprint: string, decision: ReviewDecision) {
  return { fingerprint, decision, persisted: true };
}
