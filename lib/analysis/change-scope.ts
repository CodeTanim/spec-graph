import type { AnalysisArtifactKind } from "./candidates";
import type { SemanticArtifactSnapshot } from "./semantic";

export const ANALYSIS_SCOPE_SCHEMA_VERSION = "1" as const;
export const MAX_ANALYSIS_SCOPES_PER_ARTIFACT = 6;
export const MAX_ANALYSIS_SCOPE_SIDE_CHARS = 2_400;
export const MAX_ANALYSIS_SCOPES_PER_EVENT = 24;
export const MAX_ANALYSIS_SCOPE_EVENT_CHARS = 48_000;

const MAX_LCS_CELLS = 1_000_000;

export type AnalysisScopeStatus = "available" | "unavailable";
export type AnalysisScopeChangeType = "added" | "modified" | "deleted";
export type AnalysisScopeReason =
  | "complexity_limit"
  | "event_limit"
  | "hunk_limit"
  | "missing_before_version"
  | "missing_after_version"
  | "provider_patch_unavailable";

export type ArtifactContentChange = {
  artifactId: string | null;
  path: string;
  kind: AnalysisArtifactKind | null;
  beforeRevision: string | null;
  afterRevision: string | null;
  beforeText: string | null;
  afterText: string | null;
};

export type AnalysisChangeScope = {
  schemaVersion: typeof ANALYSIS_SCOPE_SCHEMA_VERSION;
  scopeId: string;
  artifactId: string | null;
  path: string;
  artifactKind: AnalysisArtifactKind | null;
  status: AnalysisScopeStatus;
  changeType: AnalysisScopeChangeType;
  beforeRevision: string | null;
  afterRevision: string | null;
  beforeStartLine: number | null;
  beforeEndLine: number | null;
  afterStartLine: number | null;
  afterEndLine: number | null;
  beforeText: string;
  afterText: string;
  semanticText: string;
  truncated: boolean;
  reason: AnalysisScopeReason | null;
};

type ScopeDraft = {
  beforeStartLine: number | null;
  afterStartLine: number | null;
  beforeLines: string[];
  afterLines: string[];
  reason?: AnalysisScopeReason | null;
};

function lines(text: string): string[] {
  return text ? text.split("\n") : [];
}

function clipped(value: string): { text: string; truncated: boolean } {
  if (value.length <= MAX_ANALYSIS_SCOPE_SIDE_CHARS) {
    return { text: value, truncated: false };
  }
  const marker = "\n… omitted from bounded analysis scope …\n";
  const available = MAX_ANALYSIS_SCOPE_SIDE_CHARS - marker.length;
  const head = Math.ceil(available / 2);
  const tail = Math.floor(available / 2);
  return {
    text: `${value.slice(0, head)}${marker}${value.slice(-tail)}`,
    truncated: true,
  };
}

function changeType(beforeLines: string[], afterLines: string[]): AnalysisScopeChangeType {
  if (!beforeLines.length) return "added";
  if (!afterLines.length) return "deleted";
  return "modified";
}

function semanticText(
  type: AnalysisScopeChangeType,
  beforeText: string,
  afterText: string,
): string {
  if (type === "added") return `Added:\n${afterText}`;
  if (type === "deleted") return `Removed:\n${beforeText}`;
  return `Before:\n${beforeText}\n\nAfter:\n${afterText}`;
}

function toScope(
  input: Omit<ArtifactContentChange, "beforeText" | "afterText">,
  draft: ScopeDraft,
  index: number,
  reasonOverride?: AnalysisScopeReason | null,
): AnalysisChangeScope {
  const rawBefore = draft.beforeLines.join("\n");
  const rawAfter = draft.afterLines.join("\n");
  const boundedBefore = clipped(rawBefore);
  const boundedAfter = clipped(rawAfter);
  const type = changeType(draft.beforeLines, draft.afterLines);
  return {
    schemaVersion: ANALYSIS_SCOPE_SCHEMA_VERSION,
    scopeId: `${input.path}#${index + 1}`,
    artifactId: input.artifactId,
    path: input.path,
    artifactKind: input.kind,
    status: "available",
    changeType: type,
    beforeRevision: input.beforeRevision,
    afterRevision: input.afterRevision,
    beforeStartLine: draft.beforeLines.length ? draft.beforeStartLine : null,
    beforeEndLine:
      draft.beforeLines.length && draft.beforeStartLine !== null
        ? draft.beforeStartLine + draft.beforeLines.length - 1
        : null,
    afterStartLine: draft.afterLines.length ? draft.afterStartLine : null,
    afterEndLine:
      draft.afterLines.length && draft.afterStartLine !== null
        ? draft.afterStartLine + draft.afterLines.length - 1
        : null,
    beforeText: boundedBefore.text,
    afterText: boundedAfter.text,
    semanticText: semanticText(type, boundedBefore.text, boundedAfter.text),
    truncated: boundedBefore.truncated || boundedAfter.truncated,
    reason: reasonOverride ?? draft.reason ?? null,
  };
}

function evenlySelected<T>(values: T[], limit: number): T[] {
  if (values.length <= limit) return values;
  const selected: T[] = [];
  const used = new Set<number>();
  for (let index = 0; index < limit; index += 1) {
    const position = Math.round((index * (values.length - 1)) / (limit - 1));
    if (!used.has(position)) {
      selected.push(values[position]!);
      used.add(position);
    }
  }
  return selected;
}

function lcsDrafts(before: string[], after: string[]): ScopeDraft[] | null {
  const width = after.length + 1;
  const cells = (before.length + 1) * width;
  if (cells > MAX_LCS_CELLS) return null;

  const matrix = new Uint32Array(cells);
  for (let beforeIndex = before.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
    for (let afterIndex = after.length - 1; afterIndex >= 0; afterIndex -= 1) {
      const offset = beforeIndex * width + afterIndex;
      matrix[offset] = before[beforeIndex] === after[afterIndex]
        ? matrix[(beforeIndex + 1) * width + afterIndex + 1]! + 1
        : Math.max(
            matrix[(beforeIndex + 1) * width + afterIndex]!,
            matrix[beforeIndex * width + afterIndex + 1]!,
          );
    }
  }

  const drafts: ScopeDraft[] = [];
  let beforeIndex = 0;
  let afterIndex = 0;
  let current: ScopeDraft | null = null;
  const finish = () => {
    if (!current) return;
    drafts.push(current);
    current = null;
  };
  const begin = () => {
    current ||= {
      beforeStartLine: beforeIndex + 1,
      afterStartLine: afterIndex + 1,
      beforeLines: [],
      afterLines: [],
    };
    return current;
  };

  while (beforeIndex < before.length || afterIndex < after.length) {
    if (
      beforeIndex < before.length &&
      afterIndex < after.length &&
      before[beforeIndex] === after[afterIndex]
    ) {
      finish();
      beforeIndex += 1;
      afterIndex += 1;
      continue;
    }
    const deleteScore = beforeIndex < before.length
      ? matrix[(beforeIndex + 1) * width + afterIndex]!
      : -1;
    const insertScore = afterIndex < after.length
      ? matrix[beforeIndex * width + afterIndex + 1]!
      : -1;
    if (beforeIndex < before.length && (afterIndex >= after.length || deleteScore >= insertScore)) {
      begin().beforeLines.push(before[beforeIndex]!);
      beforeIndex += 1;
    } else if (afterIndex < after.length) {
      begin().afterLines.push(after[afterIndex]!);
      afterIndex += 1;
    }
  }
  finish();
  return drafts;
}

function boundedMiddleDraft(before: string[], after: string[]): ScopeDraft[] {
  let prefix = 0;
  while (
    prefix < before.length &&
    prefix < after.length &&
    before[prefix] === after[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - suffix - 1] === after[after.length - suffix - 1]
  ) {
    suffix += 1;
  }
  return [{
    beforeStartLine: prefix + 1,
    afterStartLine: prefix + 1,
    beforeLines: before.slice(prefix, before.length - suffix),
    afterLines: after.slice(prefix, after.length - suffix),
    reason: "complexity_limit",
  }];
}

export function unavailableAnalysisScope(
  input: Omit<ArtifactContentChange, "beforeText" | "afterText">,
  reason: AnalysisScopeReason,
): AnalysisChangeScope {
  const type = input.beforeRevision && !input.afterRevision
    ? "deleted"
    : !input.beforeRevision && input.afterRevision
      ? "added"
      : "modified";
  return {
    schemaVersion: ANALYSIS_SCOPE_SCHEMA_VERSION,
    scopeId: `${input.path}#unavailable`,
    artifactId: input.artifactId,
    path: input.path,
    artifactKind: input.kind,
    status: "unavailable",
    changeType: type,
    beforeRevision: input.beforeRevision,
    afterRevision: input.afterRevision,
    beforeStartLine: null,
    beforeEndLine: null,
    afterStartLine: null,
    afterEndLine: null,
    beforeText: "",
    afterText: "",
    semanticText: "",
    truncated: false,
    reason,
  };
}

export function deriveAnalysisScopes(change: ArtifactContentChange): AnalysisChangeScope[] {
  const base = {
    artifactId: change.artifactId,
    path: change.path,
    kind: change.kind,
    beforeRevision: change.beforeRevision,
    afterRevision: change.afterRevision,
  };
  if (change.beforeRevision && change.beforeText === null) {
    return [unavailableAnalysisScope(base, "missing_before_version")];
  }
  if (change.afterRevision && change.afterText === null) {
    return [unavailableAnalysisScope(base, "missing_after_version")];
  }
  const beforeText = change.beforeText || "";
  const afterText = change.afterText || "";
  if (beforeText === afterText) return [];

  const beforeLines = lines(beforeText);
  const afterLines = lines(afterText);
  const drafts = !beforeLines.length || !afterLines.length
    ? [{
        beforeStartLine: beforeLines.length ? 1 : null,
        afterStartLine: afterLines.length ? 1 : null,
        beforeLines,
        afterLines,
      }]
    : lcsDrafts(beforeLines, afterLines) || boundedMiddleDraft(beforeLines, afterLines);
  const selected = evenlySelected(drafts, MAX_ANALYSIS_SCOPES_PER_ARTIFACT);
  const omittedHunks = drafts.length > selected.length;
  return selected.map((draft, index) => {
    const scope = toScope(base, draft, index, omittedHunks ? "hunk_limit" : undefined);
    return omittedHunks ? { ...scope, truncated: true } : scope;
  });
}

export function deriveAnalysisScopesFromUnifiedPatch(
  input: Omit<ArtifactContentChange, "beforeText" | "afterText"> & {
    patch: string | null | undefined;
  },
): AnalysisChangeScope[] {
  const base = {
    artifactId: input.artifactId,
    path: input.path,
    kind: input.kind,
    beforeRevision: input.beforeRevision,
    afterRevision: input.afterRevision,
  };
  if (!input.patch) {
    return [unavailableAnalysisScope(base, "provider_patch_unavailable")];
  }
  const drafts: ScopeDraft[] = [];
  let beforeLine = 1;
  let afterLine = 1;
  let insideHunk = false;
  let current: ScopeDraft | null = null;
  const finish = () => {
    if (!current) return;
    drafts.push(current);
    current = null;
  };
  const begin = () => {
    current ||= {
      beforeStartLine: beforeLine,
      afterStartLine: afterLine,
      beforeLines: [],
      afterLines: [],
    };
    return current;
  };
  for (const line of input.patch.split("\n")) {
    const header = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) {
      finish();
      beforeLine = Number(header[1]);
      afterLine = Number(header[2]);
      insideHunk = true;
      continue;
    }
    if (!insideHunk || line === "\\ No newline at end of file") continue;
    if (line.startsWith("-")) {
      begin().beforeLines.push(line.slice(1));
      beforeLine += 1;
    } else if (line.startsWith("+")) {
      begin().afterLines.push(line.slice(1));
      afterLine += 1;
    } else if (line.startsWith(" ")) {
      finish();
      beforeLine += 1;
      afterLine += 1;
    }
  }
  finish();
  if (!drafts.length) {
    return [unavailableAnalysisScope(base, "provider_patch_unavailable")];
  }
  const selected = evenlySelected(drafts, MAX_ANALYSIS_SCOPES_PER_ARTIFACT);
  const omittedHunks = drafts.length > selected.length;
  return selected.map((draft, index) => {
    const scope = toScope(base, draft, index, omittedHunks ? "hunk_limit" : undefined);
    return omittedHunks ? { ...scope, truncated: true } : scope;
  });
}

export function serializeAnalysisScopes(scopes: AnalysisChangeScope[]): string {
  const byPath = new Map<string, AnalysisChangeScope[]>();
  for (const scope of scopes) {
    byPath.set(scope.path, [...(byPath.get(scope.path) || []), scope]);
  }
  const bounded: AnalysisChangeScope[] = [];
  const omittedByPath = new Map<string, AnalysisChangeScope>();
  let estimatedChars = 2;
  while (byPath.size && bounded.length < MAX_ANALYSIS_SCOPES_PER_EVENT) {
    let advanced = false;
    for (const [path, queue] of byPath) {
      const scope = queue.shift();
      if (!scope) {
        byPath.delete(path);
        continue;
      }
      const encodedChars = JSON.stringify(scope).length + 1;
      if (estimatedChars + encodedChars > MAX_ANALYSIS_SCOPE_EVENT_CHARS) {
        omittedByPath.set(path, scope);
      } else {
        bounded.push(scope);
        estimatedChars += encodedChars;
      }
      if (!queue.length) byPath.delete(path);
      advanced = true;
      if (bounded.length >= MAX_ANALYSIS_SCOPES_PER_EVENT) break;
    }
    if (!advanced) break;
  }
  for (const [path, queue] of byPath) {
    const representative = queue[0];
    if (representative) omittedByPath.set(path, representative);
  }
  const omissionMarkers = [...omittedByPath.values()].map((scope) => ({
    ...unavailableAnalysisScope(
      {
        artifactId: scope.artifactId,
        path: scope.path,
        kind: scope.artifactKind,
        beforeRevision: scope.beforeRevision,
        afterRevision: scope.afterRevision,
      },
      "event_limit",
    ),
    scopeId: `${scope.path}#event-limit`,
    truncated: true,
  }));
  return JSON.stringify([...bounded, ...omissionMarkers]);
}

export function parseAnalysisScopes(value: string | null | undefined): AnalysisChangeScope[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    const validKinds = new Set([
      "code",
      "config",
      "test",
      "markdown",
      "openapi",
      "confluence",
    ]);
    const validReasons = new Set<AnalysisScopeReason>([
      "complexity_limit",
      "event_limit",
      "hunk_limit",
      "missing_before_version",
      "missing_after_version",
      "provider_patch_unavailable",
    ]);
    const nullableString = (item: unknown): item is string | null =>
      item === null || typeof item === "string";
    const nullableLine = (item: unknown): item is number | null =>
      item === null || (typeof item === "number" && Number.isInteger(item) && item > 0);
    return parsed.filter((item): item is AnalysisChangeScope => {
      if (!item || typeof item !== "object") return false;
      const scope = item as Partial<AnalysisChangeScope>;
      return (
        scope.schemaVersion === ANALYSIS_SCOPE_SCHEMA_VERSION &&
        typeof scope.scopeId === "string" &&
        nullableString(scope.artifactId) &&
        typeof scope.path === "string" &&
        (scope.artifactKind === null || validKinds.has(scope.artifactKind || "")) &&
        (scope.status === "available" || scope.status === "unavailable") &&
        (scope.changeType === "added" ||
          scope.changeType === "modified" ||
          scope.changeType === "deleted") &&
        nullableString(scope.beforeRevision) &&
        nullableString(scope.afterRevision) &&
        nullableLine(scope.beforeStartLine) &&
        nullableLine(scope.beforeEndLine) &&
        nullableLine(scope.afterStartLine) &&
        nullableLine(scope.afterEndLine) &&
        typeof scope.beforeText === "string" &&
        typeof scope.afterText === "string" &&
        typeof scope.semanticText === "string" &&
        typeof scope.truncated === "boolean" &&
        (scope.reason === null || validReasons.has(scope.reason as AnalysisScopeReason)) &&
        (scope.status === "available" ? Boolean(scope.semanticText) : !scope.semanticText)
      );
    });
  } catch {
    return [];
  }
}

export function semanticSnapshotForScope(
  snapshot: SemanticArtifactSnapshot,
  scope: AnalysisChangeScope,
): SemanticArtifactSnapshot | null {
  if (scope.status !== "available" || !scope.semanticText) return null;
  if (scope.artifactId && scope.artifactId !== snapshot.artifactId) return null;
  if (scope.path !== snapshot.path) return null;
  return { ...snapshot, text: scope.semanticText };
}
