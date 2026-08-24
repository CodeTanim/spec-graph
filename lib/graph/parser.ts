import {
  openApiTextMatches,
  type ParsedOpenApiContract,
} from "../openapi/parser";
import type {
  DeterministicReference,
  IndexedArtifactKind,
  ParsedArtifactGraph,
  ParsedGraphNode,
} from "./types";

const CODE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];
const DOC_EXTENSIONS = [".md", ".mdx"];
const RESOLVABLE_EXTENSIONS = [...CODE_EXTENSIONS, ...DOC_EXTENSIONS];

function normalizePath(path: string): string {
  const output: string[] = [];
  for (const part of path.replace(/^\/+/, "").split("/")) {
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

function extensionlessCandidates(path: string): string[] {
  const withoutRuntimeExtension = path.replace(/\.(?:mjs|cjs|js|jsx)$/, "");
  return [
    path,
    withoutRuntimeExtension,
    ...RESOLVABLE_EXTENSIONS.map((extension) => `${withoutRuntimeExtension}${extension}`),
    ...CODE_EXTENSIONS.map((extension) => `${withoutRuntimeExtension}/index${extension}`),
  ];
}

function resolveReference(
  sourcePath: string,
  reference: string,
  knownPaths: Set<string>,
): string | null {
  const clean = reference.split(/[?#]/)[0]?.trim();
  if (!clean || clean.startsWith("#") || /^(?:https?|mailto|tel|data):/i.test(clean)) {
    return null;
  }

  const bases: string[] = [];
  if (clean.startsWith("./") || clean.startsWith("../")) {
    bases.push(normalizePath(`${directory(sourcePath)}/${clean}`));
  } else if (clean.startsWith("/")) {
    bases.push(normalizePath(clean));
  } else if (clean.startsWith("@/") || clean.startsWith("~/")) {
    bases.push(normalizePath(clean.slice(2)));
  } else if (knownPaths.has(clean)) {
    bases.push(clean);
  } else {
    // Bare module names are packages, not repository files. A slash makes the
    // value eligible only when it resolves exactly from the repository root.
    if (!clean.includes("/")) return null;
    bases.push(normalizePath(clean));
  }

  for (const base of bases) {
    for (const candidate of extensionlessCandidates(base)) {
      if (knownPaths.has(candidate)) return candidate;
    }
  }
  return null;
}

function referenceEvidence(content: string, index: number) {
  const evidenceStartLine = content.slice(0, Math.max(0, index)).split("\n").length;
  return {
    evidence:
      content.split("\n")[evidenceStartLine - 1]?.trim() ||
      "The indexed source contains an explicit reference.",
    evidenceStartLine,
  };
}

function addReference(
  references: Map<string, DeterministicReference>,
  sourcePath: string,
  reference: DeterministicReference,
) {
  if (reference.targetPath === sourcePath) return;
  // One strongest explanation per target keeps the graph small and prevents a
  // Markdown link from also becoming a weaker duplicate plain-text edge.
  const key = reference.targetPath;
  const existing = references.get(key);
  if (
    !existing ||
    reference.confidence > existing.confidence ||
    (reference.confidence === existing.confidence &&
      reference.evidenceStartLine < existing.evidenceStartLine)
  ) {
    references.set(key, reference);
  }
}

function testTargetCandidates(sourcePath: string): string[] {
  const normalized = normalizePath(sourcePath);
  const parts = normalized.split("/");
  const filename = parts.at(-1) || normalized;
  const stem = filename.replace(/\.(?:test|spec)\.[jt]sx?$/, "");
  if (stem === filename) return [];

  const sourceDirectory = parts.slice(0, -1).filter((part) =>
    !["test", "tests", "spec", "specs", "__tests__"].includes(part.toLowerCase()),
  );
  const relativeTail = [...sourceDirectory, stem].join("/");
  const tailWithoutTestRoot = relativeTail.replace(/^(?:test|tests|spec|specs)\//i, "");
  const bases = new Set([
    relativeTail,
    tailWithoutTestRoot,
    `src/${tailWithoutTestRoot}`,
    `app/${tailWithoutTestRoot}`,
    `lib/${tailWithoutTestRoot}`,
  ]);
  return [...bases].flatMap((base) =>
    CODE_EXTENSIONS.map((extension) => `${base}${extension}`),
  );
}

function markdownNodes(path: string, content: string): ParsedGraphNode[] {
  const lines = content.split("\n");
  const headings = lines.flatMap((line, index) => {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) return [];
    return [{ line: index + 1, name: match[2].trim() }];
  });
  const occurrences = new Map<string, number>();
  return headings.map((heading, index) => {
    const slug = heading.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "section";
    const occurrence = (occurrences.get(slug) || 0) + 1;
    occurrences.set(slug, occurrence);
    return {
      stableKey: `section:${path}#${slug}:${occurrence}`,
      kind: "doc_section" as const,
      name: heading.name,
      startLine: heading.line,
      endLine: Math.max(heading.line, (headings[index + 1]?.line || lines.length + 1) - 1),
    };
  });
}

export function parseArtifactGraph(
  sourcePath: string,
  sourceKind: IndexedArtifactKind,
  content: string,
  knownPaths: Set<string>,
  openApiContracts: Map<string, ParsedOpenApiContract[]>,
): ParsedArtifactGraph {
  const references = new Map<string, DeterministicReference>();
  const lineCount = Math.max(1, content.split("\n").length);
  const nodes: ParsedGraphNode[] = [
    {
      stableKey: `file:${sourcePath}`,
      kind:
        sourceKind === "test"
          ? "test"
          : sourceKind === "markdown"
            ? "doc_section"
            : sourceKind === "openapi"
              ? "schema"
              : "file",
      name: sourcePath,
      startLine: 1,
      endLine: lineCount,
    },
  ];
  if (sourceKind === "markdown") nodes.push(...markdownNodes(sourcePath, content));

  if (sourceKind === "code" || sourceKind === "test" || sourcePath.endsWith(".mdx")) {
    const modulePatterns = [
      /(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g,
      /(?:import\s*\(|require\s*\()\s*["']([^"']+)["']/g,
    ];
    for (const pattern of modulePatterns) {
      for (const match of content.matchAll(pattern)) {
        const targetPath = resolveReference(sourcePath, match[1], knownPaths);
        if (!targetPath) continue;
        addReference(references, sourcePath, {
          targetPath,
          type: sourceKind === "test" ? "references" : "imports",
          confidence: 1,
          ...referenceEvidence(content, match.index ?? 0),
        });
      }
    }
  }

  if (sourceKind === "test") {
    for (const candidate of testTargetCandidates(sourcePath)) {
      if (!knownPaths.has(candidate)) continue;
      addReference(references, sourcePath, {
        targetPath: candidate,
        type: "tests",
        confidence: 0.86,
        evidence: `The test filename maps to ${candidate}.`,
        evidenceStartLine: 1,
      });
    }
  }

  if (sourceKind === "markdown") {
    const linkPattern = /\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g;
    for (const match of content.matchAll(linkPattern)) {
      const targetPath = resolveReference(sourcePath, match[1], knownPaths);
      if (!targetPath) continue;
      addReference(references, sourcePath, {
        targetPath,
        type: "links",
        confidence: 1,
        ...referenceEvidence(content, match.index ?? 0),
      });
    }
  }

  for (const targetPath of knownPaths) {
    if (targetPath === sourcePath) continue;
    const index = content.indexOf(targetPath);
    if (index < 0) continue;
    addReference(references, sourcePath, {
      targetPath,
      type: "references",
      confidence: 0.96,
      ...referenceEvidence(content, index),
    });
  }

  if (sourceKind !== "openapi") {
    for (const [openApiPath, contracts] of openApiContracts) {
      for (const match of openApiTextMatches(content, contracts)) {
        addReference(references, sourcePath, {
          targetPath: openApiPath,
          type: `covers_openapi:${match.matchKey}`,
          confidence: 1,
          evidence: match.evidence,
          evidenceStartLine: match.evidenceStartLine,
        });
      }
    }
  }

  return { nodes, references: [...references.values()] };
}

export function extractDeterministicReferences(
  sourcePath: string,
  sourceKind: IndexedArtifactKind,
  content: string,
  knownPaths: Set<string>,
  openApiContracts: Map<string, ParsedOpenApiContract[]>,
): DeterministicReference[] {
  return parseArtifactGraph(
    sourcePath,
    sourceKind,
    content,
    knownPaths,
    openApiContracts,
  ).references;
}
