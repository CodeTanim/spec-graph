export function disconnectSource(sourceId: string) {
  return {
    sourceId,
    stopRefresh: true,
    removeCurrentIndex: true,
    preserveSafeReviewHistory: true,
  };
}
