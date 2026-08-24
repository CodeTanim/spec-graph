import { parse as parseYaml } from "yaml";

const HTTP_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
] as const;

type JsonObject = Record<string, unknown>;

export type OpenApiEntity = {
  stableKey: string;
  kind: "operation" | "schema";
  name: string;
  path: string | null;
  method: string | null;
  startLine: number;
  snapshot: JsonObject;
  refs: string[];
};

export type ParsedOpenApiContract = {
  entities: OpenApiEntity[];
  fingerprint: string;
};

export type OpenApiChange = {
  stableKey: string;
  name: string;
  kind: "operation" | "schema" | "document";
  summary: string;
  startLine: number;
  matchKeys: string[];
};

export type OpenApiTextMatch = {
  matchKey: string;
  label: string;
  evidence: string;
  evidenceStartLine: number;
};

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function canonicalObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalObject);
  const record = object(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalObject(record[key])]),
  );
}

function entitySnapshot(value: JsonObject): JsonObject {
  return canonicalObject(value) as JsonObject;
}

function collectRefs(value: unknown, refs = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, refs);
    return refs;
  }
  const record = object(value);
  if (!record) return refs;
  if (typeof record.$ref === "string") refs.add(record.$ref);
  for (const child of Object.values(record)) collectRefs(child, refs);
  return refs;
}

function findKeyLine(content: string, key: string): number {
  const lines = content.split("\n");
  const quoted = [`\"${key}\"`, `'${key}'`];
  const index = lines.findIndex((line) => {
    const trimmed = line.trimStart();
    return (
      trimmed.startsWith(`${key}:`) ||
      quoted.some((candidate) => trimmed.startsWith(`${candidate}:`))
    );
  });
  return index >= 0 ? index + 1 : 1;
}

function parseRoot(content: string): JsonObject {
  const parsed = parseYaml(content, { maxAliasCount: 20 });
  const root = object(parsed);
  if (!root) throw new Error("OpenAPI document must contain an object at its root.");
  if (typeof root.openapi !== "string" && typeof root.swagger !== "string") {
    throw new Error("OpenAPI document is missing an openapi or swagger version.");
  }
  return root;
}

export function parseOpenApiContract(content: string): ParsedOpenApiContract {
  const root = parseRoot(content);
  const entities: OpenApiEntity[] = [];
  const paths = object(root.paths) || {};

  for (const [path, pathValue] of Object.entries(paths)) {
    const pathItem = object(pathValue);
    if (!pathItem) continue;
    for (const method of HTTP_METHODS) {
      const operation = object(pathItem[method]);
      if (!operation) continue;
      entities.push({
        stableKey: `operation:${method.toUpperCase()}:${path}`,
        kind: "operation",
        name: `${method.toUpperCase()} ${path}`,
        path,
        method: method.toUpperCase(),
        startLine: findKeyLine(content, path),
        snapshot: entitySnapshot(operation),
        refs: [...collectRefs(operation)].sort(),
      });
    }
  }

  const components = object(root.components);
  const schemas = object(components?.schemas) || object(root.definitions) || {};
  for (const [name, schemaValue] of Object.entries(schemas)) {
    const schema = object(schemaValue);
    if (!schema) continue;
    entities.push({
      stableKey: `schema:${name}`,
      kind: "schema",
      name,
      path: null,
      method: null,
      startLine: findKeyLine(content, name),
      snapshot: entitySnapshot(schema),
      refs: [...collectRefs(schema)].sort(),
    });
  }

  return { entities, fingerprint: serialized(root) };
}

function serialized(value: unknown): string {
  return JSON.stringify(canonicalObject(value));
}

function parameters(operation: JsonObject): Map<string, JsonObject> {
  const result = new Map<string, JsonObject>();
  if (!Array.isArray(operation.parameters)) return result;
  for (const value of operation.parameters) {
    const parameter = object(value);
    const name = typeof parameter?.name === "string" ? parameter.name : null;
    const location = typeof parameter?.in === "string" ? parameter.in : null;
    if (parameter && name && location) result.set(`${location}:${name}`, parameter);
  }
  return result;
}

function responseCodes(operation: JsonObject): Set<string> {
  return new Set(Object.keys(object(operation.responses) || {}));
}

function setDifference(left: Set<string>, right: Set<string>): string[] {
  return [...left].filter((item) => !right.has(item));
}

function operationSummary(
  name: string,
  before: JsonObject,
  after: JsonObject,
): string {
  const beforeParameters = parameters(before);
  const afterParameters = parameters(after);
  for (const [key, parameter] of afterParameters) {
    const previous = beforeParameters.get(key);
    if (previous?.required !== true && parameter.required === true) {
      return `${name}: ${key.split(":")[1]} is now required.`;
    }
  }
  const beforeBody = object(before.requestBody);
  const afterBody = object(after.requestBody);
  if (beforeBody?.required !== true && afterBody?.required === true) {
    return `${name}: the request body is now required.`;
  }
  const addedResponses = setDifference(responseCodes(after), responseCodes(before));
  const removedResponses = setDifference(responseCodes(before), responseCodes(after));
  if (addedResponses.length || removedResponses.length) {
    const details = [
      addedResponses.length ? `added responses ${addedResponses.join(", ")}` : null,
      removedResponses.length ? `removed responses ${removedResponses.join(", ")}` : null,
    ].filter(Boolean).join("; ");
    return `${name}: ${details}.`;
  }
  return `${name}: the operation contract changed.`;
}

function schemaProperties(schema: JsonObject): Map<string, JsonObject> {
  const result = new Map<string, JsonObject>();
  for (const [name, value] of Object.entries(object(schema.properties) || {})) {
    const property = object(value);
    if (property) result.set(name, property);
  }
  return result;
}

function schemaSummary(name: string, before: JsonObject, after: JsonObject): string {
  const beforeRequired = new Set(stringArray(before.required));
  const afterRequired = new Set(stringArray(after.required));
  const newlyRequired = setDifference(afterRequired, beforeRequired);
  if (newlyRequired.length) {
    return `${name}: ${newlyRequired.join(", ")} ${newlyRequired.length === 1 ? "is" : "are"} now required.`;
  }
  const noLongerRequired = setDifference(beforeRequired, afterRequired);
  if (noLongerRequired.length) {
    return `${name}: ${noLongerRequired.join(", ")} ${noLongerRequired.length === 1 ? "is" : "are"} no longer required.`;
  }
  const beforeProperties = schemaProperties(before);
  const afterProperties = schemaProperties(after);
  const added = setDifference(new Set(afterProperties.keys()), new Set(beforeProperties.keys()));
  const removed = setDifference(new Set(beforeProperties.keys()), new Set(afterProperties.keys()));
  if (added.length || removed.length) {
    const details = [
      added.length ? `added fields ${added.join(", ")}` : null,
      removed.length ? `removed fields ${removed.join(", ")}` : null,
    ].filter(Boolean).join("; ");
    return `${name}: ${details}.`;
  }
  for (const [propertyName, property] of afterProperties) {
    const previous = beforeProperties.get(propertyName);
    if (previous && serialized(previous) !== serialized(property)) {
      return `${name}.${propertyName}: the field contract changed.`;
    }
  }
  return `${name}: the schema contract changed.`;
}

function referencingOperationKeys(
  contract: ParsedOpenApiContract,
  schemaName: string,
): string[] {
  const suffix = `/schemas/${schemaName}`;
  return contract.entities
    .filter(
      (entity) =>
        entity.kind === "operation" &&
        entity.refs.some((reference) => reference.endsWith(suffix)),
    )
    .flatMap((entity) => [
      entity.stableKey,
      ...(entity.path ? [`path:${entity.path}`] : []),
    ]);
}

export function diffOpenApiContracts(
  beforeContent: string | null,
  afterContent: string,
): OpenApiChange[] {
  const before = beforeContent
    ? parseOpenApiContract(beforeContent)
    : { entities: [], fingerprint: "" };
  const after = parseOpenApiContract(afterContent);
  const beforeByKey = new Map(before.entities.map((entity) => [entity.stableKey, entity]));
  const afterByKey = new Map(after.entities.map((entity) => [entity.stableKey, entity]));
  const keys = new Set([...beforeByKey.keys(), ...afterByKey.keys()]);
  const changes: OpenApiChange[] = [];

  for (const key of keys) {
    const previous = beforeByKey.get(key);
    const current = afterByKey.get(key);
    if (previous && current && serialized(previous.snapshot) === serialized(current.snapshot)) {
      continue;
    }
    const entity = current || previous;
    if (!entity) continue;
    const matchKeys = new Set([
      entity.stableKey,
      ...(entity.path ? [`path:${entity.path}`] : []),
    ]);
    if (entity.kind === "schema") {
      for (const reference of [
        ...referencingOperationKeys(before, entity.name),
        ...referencingOperationKeys(after, entity.name),
      ]) matchKeys.add(reference);
    }
    const summary = !previous
      ? `${entity.name}: ${entity.kind === "operation" ? "operation" : "schema"} added.`
      : !current
        ? `${entity.name}: ${entity.kind === "operation" ? "operation" : "schema"} removed.`
        : entity.kind === "operation"
          ? operationSummary(entity.name, previous.snapshot, current.snapshot)
          : schemaSummary(entity.name, previous.snapshot, current.snapshot);
    changes.push({
      stableKey: entity.stableKey,
      name: entity.name,
      kind: entity.kind,
      summary,
      startLine: entity.startLine,
      matchKeys: [...matchKeys],
    });
  }

  if (!changes.length && before.fingerprint !== after.fingerprint) {
    changes.push({
      stableKey: "document",
      name: "OpenAPI document",
      kind: "document",
      summary: "The OpenAPI document metadata changed.",
      startLine: 1,
      matchKeys: ["document"],
    });
  }
  return changes;
}

function containsIdentifier(text: string, identifier: string): boolean {
  if (identifier.startsWith("/")) return text.includes(identifier);
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`).test(text);
}

export function openApiTextMatches(
  content: string,
  contracts: ParsedOpenApiContract[],
): OpenApiTextMatch[] {
  const matches = new Map<string, OpenApiTextMatch>();
  const lines = content.split("\n");
  for (const contract of contracts) {
    for (const entity of contract.entities) {
      const candidates = entity.kind === "operation"
        ? [
            { identifier: entity.name, matchKey: entity.stableKey },
            ...(entity.path ? [{ identifier: entity.path, matchKey: `path:${entity.path}` }] : []),
          ]
        : [
            { identifier: `#/components/schemas/${entity.name}`, matchKey: entity.stableKey },
            { identifier: `#/definitions/${entity.name}`, matchKey: entity.stableKey },
            { identifier: `\`${entity.name}\``, matchKey: entity.stableKey },
            { identifier: `\"${entity.name}\"`, matchKey: entity.stableKey },
            { identifier: `${entity.name} schema`, matchKey: entity.stableKey },
            { identifier: `schema ${entity.name}`, matchKey: entity.stableKey },
          ];
      const candidate = candidates.find(({ identifier }) =>
        containsIdentifier(content, identifier),
      );
      if (!candidate || matches.has(candidate.matchKey)) continue;
      const lineIndex = lines.findIndex((line) =>
        containsIdentifier(line, candidate.identifier),
      );
      matches.set(candidate.matchKey, {
        matchKey: candidate.matchKey,
        label: entity.name,
        evidence: lines[lineIndex]?.trim() || `References ${entity.name}.`,
        evidenceStartLine: lineIndex >= 0 ? lineIndex + 1 : 1,
      });
    }
  }
  return [...matches.values()];
}
