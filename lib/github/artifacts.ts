import type { ArtifactKind, ChangedArtifact } from "../contracts/specgraph";
import {
  parseOpenApiContract,
} from "../openapi/parser";
export {
  extractDeterministicReferences,
  parseArtifactGraph,
} from "../graph/parser";
export type {
  DeterministicReference,
  IndexedArtifactKind,
  ParsedArtifactGraph,
  ParsedGraphNode,
} from "../graph/types";
import type { IndexedArtifactKind } from "../graph/types";

const CODE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];
const DOC_EXTENSIONS = [".md", ".mdx"];
const OPENAPI_NAMES = [
  "openapi.json",
  "openapi.yaml",
  "openapi.yml",
  "swagger.json",
  "swagger.yaml",
  "swagger.yml",
];
const IGNORED_SEGMENTS = new Set([
  ".agents",
  ".git",
  ".next",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "vendor",
]);

export function classifyGitHubArtifact(path: string): IndexedArtifactKind | null {
  const lower = path.toLowerCase();
  if (lower.split("/").some((segment) => IGNORED_SEGMENTS.has(segment))) return null;
  const filename = lower.split("/").at(-1) || lower;
  if (OPENAPI_NAMES.includes(filename)) return "openapi";
  if (DOC_EXTENSIONS.some((extension) => lower.endsWith(extension))) return "markdown";
  if (!CODE_EXTENSIONS.some((extension) => lower.endsWith(extension))) return null;
  if (
    /(^|\/)(__tests__|tests?|specs?)(\/|$)/.test(lower) ||
    /\.(test|spec)\.[jt]sx?$/.test(lower)
  ) {
    return "test";
  }
  return "code";
}

export function displayArtifactKind(kind: IndexedArtifactKind): ArtifactKind {
  switch (kind) {
    case "test":
      return "Test";
    case "markdown":
      return "Markdown";
    case "openapi":
      return "OpenAPI";
    default:
      return "Code";
  }
}

export function changedArtifactSnapshot(
  path: string,
  externalUrl: string | null,
  changeType?: ChangedArtifact["changeType"],
): ChangedArtifact {
  const indexedKind = classifyGitHubArtifact(path);
  return {
    id: path,
    name: path.split("/").at(-1) || path,
    kind: indexedKind ? displayArtifactKind(indexedKind) : "File",
    location: path,
    externalUrl,
    ...(changeType ? { changeType } : {}),
  };
}

export function extractOpenApiEndpoints(content: string): string[] {
  try {
    return [
      ...new Set(
        parseOpenApiContract(content).entities.flatMap((entity) =>
          entity.path ? [entity.path] : [],
        ),
      ),
    ].slice(0, 200);
  } catch {
    return [];
  }
}
