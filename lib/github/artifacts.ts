import type { ArtifactKind } from "../contracts/specgraph";

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
  ".git",
  ".next",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "vendor",
]);

export type IndexedArtifactKind =
  | "code"
  | "test"
  | "markdown"
  | "openapi";

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

function normalizePath(path: string): string {
  const output: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") output.pop();
    else output.push(part);
  }
  return output.join("/");
}

function directory(path: string): string {
  const parts = path.split("/");
  parts.pop();
  return parts.join("/");
}

function resolveReference(
  sourcePath: string,
  reference: string,
  knownPaths: Set<string>,
): string | null {
  const clean = reference.split(/[?#]/)[0];
  if (!clean || /^(?:[a-z]+:|#)/i.test(reference)) return null;
  const base = clean.startsWith("/")
    ? normalizePath(clean)
    : normalizePath(`${directory(sourcePath)}/${clean}`);
  const candidates = [
    base,
    ...CODE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...DOC_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...CODE_EXTENSIONS.map((extension) => `${base}/index${extension}`),
  ];
  return candidates.find((candidate) => knownPaths.has(candidate)) || null;
}

export type DeterministicReference = {
  targetPath: string;
  type: "imports" | "links" | "references" | "covers_endpoint";
  evidence: string;
};

export function extractDeterministicReferences(
  sourcePath: string,
  sourceKind: IndexedArtifactKind,
  content: string,
  knownPaths: Set<string>,
  openApiEndpoints: Map<string, string[]>,
): DeterministicReference[] {
  const references = new Map<string, DeterministicReference>();
  const add = (reference: DeterministicReference) => {
    if (reference.targetPath === sourcePath) return;
    references.set(`${reference.type}:${reference.targetPath}`, reference);
  };

  if (sourceKind === "code" || sourceKind === "test") {
    const importPattern = /(?:from\s+|import\s*\(|require\s*\()\s*["']([^"']+)["']/g;
    for (const match of content.matchAll(importPattern)) {
      const targetPath = resolveReference(sourcePath, match[1], knownPaths);
      if (targetPath) {
        add({
          targetPath,
          type: sourceKind === "test" ? "references" : "imports",
          evidence: `References ${match[1]} from ${sourcePath}`,
        });
      }
    }
  }

  if (sourceKind === "markdown") {
    const linkPattern = /\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g;
    for (const match of content.matchAll(linkPattern)) {
      const targetPath = resolveReference(sourcePath, match[1], knownPaths);
      if (targetPath) {
        add({
          targetPath,
          type: "links",
          evidence: `Links to ${match[1]} from ${sourcePath}`,
        });
      }
    }
  }

  for (const targetPath of knownPaths) {
    if (targetPath !== sourcePath && content.includes(targetPath)) {
      add({
        targetPath,
        type: "references",
        evidence: `Mentions ${targetPath} in ${sourcePath}`,
      });
    }
  }

  if (sourceKind !== "openapi") {
    for (const [openApiPath, endpoints] of openApiEndpoints) {
      const endpoint = endpoints.find((candidate) => content.includes(candidate));
      if (endpoint) {
        add({
          targetPath: openApiPath,
          type: "covers_endpoint",
          evidence: `Shares endpoint ${endpoint} with ${openApiPath}`,
        });
      }
    }
  }

  return [...references.values()];
}

export function extractOpenApiEndpoints(content: string): string[] {
  const endpoints = new Set<string>();
  for (const match of content.matchAll(/^\s{0,8}(\/[A-Za-z0-9_{}:./-]+)\s*:/gm)) {
    endpoints.add(match[1]);
  }
  for (const match of content.matchAll(/["'](\/[A-Za-z0-9_{}:./-]+)["']\s*:/g)) {
    endpoints.add(match[1]);
  }
  return [...endpoints].slice(0, 200);
}
