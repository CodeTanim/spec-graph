export function refreshConfluencePages(previousVersion: number, currentVersion: number) {
  return {
    changed: currentVersion > previousVersion,
    analysisCadence: "daily",
    incremental: true,
  };
}
