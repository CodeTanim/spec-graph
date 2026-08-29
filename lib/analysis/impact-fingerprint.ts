import { sha256Hex } from "../github/crypto";

export type ImpactFingerprintInput = {
  changed: {
    nodeId: string;
    revision: string;
  };
  affected: {
    artifactId: string;
    revision: string;
  };
  relationship: {
    origin: "deterministic" | "semantic" | "hybrid";
    provenance: string;
    analyzerVersion: string;
    signals: Array<{
      type: string;
      origin: "deterministic" | "semantic" | "hybrid";
      provenance: string;
      analyzerVersion: string;
      evidence: string;
      evidenceStartLine: number | null;
    }>;
  };
  evidence: {
    location: string;
    excerpt: string;
  };
};

/**
 * Identifies one reviewable impact independently of the run that discovered it.
 * A repeated analysis of the same revisions and evidence reuses the fingerprint;
 * a changed revision or changed verified evidence creates a new review item.
 */
export async function createImpactFingerprint(
  input: ImpactFingerprintInput,
): Promise<string> {
  const digest = await sha256Hex(JSON.stringify({ version: 1, ...input }));
  return `impact_v1_${digest}`;
}
