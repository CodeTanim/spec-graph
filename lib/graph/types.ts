export type IndexedArtifactKind =
  | "code"
  | "test"
  | "markdown"
  | "openapi";

export type ParsedGraphNode = {
  stableKey: string;
  kind: "file" | "symbol" | "endpoint" | "schema" | "doc_section" | "test";
  name: string;
  startLine: number;
  endLine: number;
};

export type DeterministicReference = {
  targetPath: string;
  type: string;
  provenance:
    | "IMPORT"
    | "TEST_NAMING"
    | "EXPLICIT_LINK"
    | "EXACT_PATH"
    | "OPENAPI_ENTITY";
  evidence: string;
  evidenceStartLine: number;
  confidence: number;
};

export type ParsedArtifactGraph = {
  nodes: ParsedGraphNode[];
  references: DeterministicReference[];
};
