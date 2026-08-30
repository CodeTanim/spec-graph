export const automaticAnalysisCadence = "daily";

export function shouldScheduleDailyAnalysis(lastCompletedAt: Date, now: Date) {
  return now.getTime() - lastCompletedAt.getTime() >= 24 * 60 * 60 * 1000;
}
