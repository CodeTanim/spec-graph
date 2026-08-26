import { extractArtifactEntities, type GraphEntity } from "./entities";
import type { IndexedArtifactKind } from "./types";

export type RelationshipProvenance =
  | "EXACT_IDENTIFIER"
  | "OPENAPI_ENTITY"
  | "SHARED_ENTITY";

export type EntityArtifact = {
  artifactId: string;
  sourceId: string;
  kind: IndexedArtifactKind | "confluence";
  path: string;
  rootNodeId: string;
  text: string;
  entityNodeIds?: Map<string, string>;
};

export type EntityRelationship = {
  fromNodeId: string;
  toNodeId: string;
  type: string;
  origin: "deterministic" | "hybrid";
  provenance: RelationshipProvenance;
  confidence: number;
  evidence: string;
  evidenceStartLine: number;
};

type IndexedEntities = EntityArtifact & {
  entities: GraphEntity[];
  entitiesByKey: Map<string, GraphEntity>;
};

function isDocumentation(kind: EntityArtifact["kind"]): boolean {
  return kind === "markdown" || kind === "confluence";
}
function relationshipKey(relationship: EntityRelationship): string {
  return [
    relationship.fromNodeId,
    relationship.toNodeId,
    relationship.type,
    relationship.origin,
  ].join("\u0000");
}

function addRelationship(
  output: Map<string, EntityRelationship>,
  relationship: EntityRelationship,
) {
  if (relationship.fromNodeId === relationship.toNodeId) return;
  const key = relationshipKey(relationship);
  const existing = output.get(key);
  if (!existing || relationship.confidence > existing.confidence) {
    output.set(key, relationship);
  }
}

function strongSharedEntity(entity: GraphEntity): boolean {
  if (entity.kind === "endpoint") return true;
  return /(?:Service|Status|Request|Response|Controller|Repository|Schema|Policy|Workflow|Event|Command|Query|Config)$/i.test(
    entity.label,
  );
}

export function discoverEntityRelationships(
  artifacts: EntityArtifact[],
): EntityRelationship[] {
  const indexed: IndexedEntities[] = artifacts.map((artifact) => {
    const entities = extractArtifactEntities(artifact.kind, artifact.text);
    return {
      ...artifact,
      entities,
      entitiesByKey: new Map(entities.map((entity) => [entity.key, entity])),
    };
  });
  const output = new Map<string, EntityRelationship>();
  const definitions = indexed.flatMap((artifact) =>
    artifact.entities
      .filter((entity) => entity.role === "defines")
      .map((entity) => ({ artifact, entity })),
  );

  for (const document of indexed.filter((artifact) => isDocumentation(artifact.kind))) {
    for (const mention of document.entities.filter((entity) => entity.role === "mentions")) {
      for (const definition of definitions) {
        if (
          definition.artifact.artifactId === document.artifactId ||
          definition.entity.key !== mention.key
        ) {
          continue;
        }
        const endpoint = mention.kind === "endpoint";
        addRelationship(output, {
          fromNodeId: document.rootNodeId,
          toNodeId:
            definition.artifact.entityNodeIds?.get(definition.entity.key) ||
            definition.artifact.rootNodeId,
          type: `mentions_entity:${mention.key}`,
          origin: "deterministic",
          provenance: endpoint ? "OPENAPI_ENTITY" : "EXACT_IDENTIFIER",
          confidence: endpoint ? 0.98 : 0.95,
          evidence: mention.evidence,
          evidenceStartLine: mention.line,
        });
      }
    }
  }

  const documents = indexed.filter((artifact) => isDocumentation(artifact.kind));
  for (let leftIndex = 0; leftIndex < documents.length; leftIndex += 1) {
    const left = documents[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < documents.length; rightIndex += 1) {
      const right = documents[rightIndex];
      if (left.sourceId === right.sourceId) continue;
      const shared = left.entities.filter((entity) =>
        entity.role === "mentions" && right.entitiesByKey.has(entity.key),
      );
      const accepted = shared.filter(strongSharedEntity);
      const selected = accepted[0] || (shared.length >= 2 ? shared[0] : null);
      if (!selected) continue;
      const rightEvidence = right.entitiesByKey.get(selected.key);
      if (!rightEvidence) continue;
      const confidence = selected.kind === "endpoint" ? 0.9 : shared.length >= 2 ? 0.86 : 0.82;
      const type = `shares_entity:${selected.key}`;
      addRelationship(output, {
        fromNodeId: left.rootNodeId,
        toNodeId: right.rootNodeId,
        type,
        origin: "hybrid",
        provenance: "SHARED_ENTITY",
        confidence,
        evidence: left.entitiesByKey.get(selected.key)?.evidence || selected.evidence,
        evidenceStartLine: left.entitiesByKey.get(selected.key)?.line || selected.line,
      });
      addRelationship(output, {
        fromNodeId: right.rootNodeId,
        toNodeId: left.rootNodeId,
        type,
        origin: "hybrid",
        provenance: "SHARED_ENTITY",
        confidence,
        evidence: rightEvidence.evidence,
        evidenceStartLine: rightEvidence.line,
      });
    }
  }

  return [...output.values()];
}
