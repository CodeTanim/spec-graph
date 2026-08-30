export function renameInternalCacheKey(previousKey: string) {
  return previousKey.replace("artifact-buffer", "artifact-cache");
}
