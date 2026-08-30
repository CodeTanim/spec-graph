export function startManualAnalysis(target: string) {
  return {
    target,
    execution: "immediate",
    progressPresentation: "centered dialog",
  };
}
