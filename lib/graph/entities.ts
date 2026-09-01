import { parseOpenApiContract } from "../openapi/parser";
import type { IndexedArtifactKind } from "./types";

export type GraphEntityKind = "endpoint" | "identifier";
export type GraphEntityRole = "defines" | "mentions";

export type GraphEntity = {
  key: string;
  kind: GraphEntityKind;
  label: string;
  role: GraphEntityRole;
  stableKey: string;
  line: number;
  evidence: string;
  confidence: number;
};

const IDENTIFIER_STOP_WORDS = new Set([
  "API",
  "Confluence",
  "GitHub",
  "JavaScript",
  "Markdown",
  "Notion",
  "OpenAPI",
  "SpecGraph",
  "TypeScript",
]);

const HTTP_METHODS = "GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD";

function sourceLine(content: string, index: number) {
  const line = content.slice(0, Math.max(0, index)).split("\n").length;
  return {
    line,
    evidence: content.split("\n")[line - 1]?.trim() || "Exact entity match.",
  };
}
function normalizedEndpoint(method: string, path: string): string {
  return `${method.toUpperCase()} ${path.replace(/[),.;]+$/, "")}`;
}

function entityKey(kind: GraphEntityKind, label: string): string {
  return `${kind}:${label.toLowerCase()}`;
}

function addEntity(
  entities: Map<string, GraphEntity>,
  entity: Omit<GraphEntity, "key" | "stableKey">,
) {
  const key = entityKey(entity.kind, entity.label);
  const existing = entities.get(key);
  if (existing && existing.confidence >= entity.confidence) return;
  entities.set(key, {
    ...entity,
    key,
    stableKey: `entity:${key}`,
  });
}

export function extractCodeDefinitions(content: string): GraphEntity[] {
  const entities = new Map<string, GraphEntity>();
  const declarationPattern = /\b(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:class|interface|type|enum|function)\s+([A-Za-z_$][\w$]*)/g;
  for (const match of content.matchAll(declarationPattern)) {
    const label = match[1];
    if (!label || label.length < 3) continue;
    addEntity(entities, {
      kind: "identifier",
      label,
      role: "defines",
      ...sourceLine(content, match.index ?? 0),
      confidence: 0.96,
    });
  }

  const constantPattern = /\b(?:export\s+)?const\s+([A-Z][A-Za-z0-9_$]{3,})\b/g;
  for (const match of content.matchAll(constantPattern)) {
    const label = match[1];
    if (!label) continue;
    addEntity(entities, {
      kind: "identifier",
      label,
      role: "defines",
      ...sourceLine(content, match.index ?? 0),
      confidence: 0.94,
    });
  }
  return [...entities.values()];
}

export function extractDocumentMentions(content: string): GraphEntity[] {
  const entities = new Map<string, GraphEntity>();
  const endpointPattern = new RegExp(`\\b(${HTTP_METHODS})\\s+(/[^\\s\\]}>\"']+)`, "gi");
  for (const match of content.matchAll(endpointPattern)) {
    const label = normalizedEndpoint(match[1], match[2]);
    addEntity(entities, {
      kind: "endpoint",
      label,
      role: "mentions",
      ...sourceLine(content, match.index ?? 0),
      confidence: 0.98,
    });
  }

  const identifierPattern = /\b[A-Z][A-Za-z0-9_$]*[a-z][A-Za-z0-9_$]*\b/g;
  for (const match of content.matchAll(identifierPattern)) {
    const label = match[0];
    if (label.length < 5 || IDENTIFIER_STOP_WORDS.has(label)) continue;
    addEntity(entities, {
      kind: "identifier",
      label,
      role: "mentions",
      ...sourceLine(content, match.index ?? 0),
      confidence: 0.9,
    });
  }
  return [...entities.values()];
}

export function extractOpenApiDefinitions(content: string): GraphEntity[] {
  const entities = new Map<string, GraphEntity>();
  try {
    const contract = parseOpenApiContract(content);
    for (const entity of contract.entities) {
      const kind = entity.kind === "operation" ? "endpoint" : "identifier";
      addEntity(entities, {
        kind,
        label: entity.name,
        role: "defines",
        line: entity.startLine,
        evidence: entity.name,
        confidence: 1,
      });
      if (entity.kind === "operation" && entity.path && entity.method) {
        addEntity(entities, {
          kind: "endpoint",
          label: normalizedEndpoint(entity.method, entity.path),
          role: "defines",
          line: entity.startLine,
          evidence: entity.name,
          confidence: 1,
        });
      }
    }
  } catch {
    // Invalid OpenAPI remains an indexed artifact but cannot define entities.
  }
  return [...entities.values()];
}

export function extractArtifactEntities(
  kind: IndexedArtifactKind | "confluence",
  content: string,
): GraphEntity[] {
  if (kind === "openapi") return extractOpenApiDefinitions(content);
  if (kind === "code" || kind === "test") return extractCodeDefinitions(content);
  if (kind === "config") return [];
  return extractDocumentMentions(content);
}
