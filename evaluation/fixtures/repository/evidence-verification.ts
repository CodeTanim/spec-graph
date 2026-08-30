export function verifyEvidence(sourceText: string, excerpt: string) {
  return sourceText.includes(excerpt)
    ? { verified: true, displayConfidence: true }
    : { verified: false, displayConfidence: false };
}
