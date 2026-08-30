import { startManualAnalysis } from "./manual-analysis";

export function verifiesProgressDialog() {
  return startManualAnalysis("latest").progressPresentation === "centered dialog";
}
