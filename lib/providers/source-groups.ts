import { and, count, eq, inArray, sql } from "drizzle-orm";
import { getDb, type SpecGraphDb } from "../../db";
import {
  sourceGroupMembers,
  sourceGroups,
  sources,
} from "../../db/schema";
import { ApiError } from "../server/http";

export type SourceGroupMembershipResult = {
  groupId: string;
  alreadyInGroup: boolean;
  merged: boolean;
};

async function requireWorkspaceSource(
  workspaceId: string,
  sourceId: string,
  db: SpecGraphDb,
) {
  const [source] = await db
    .select({ id: sources.id, name: sources.name })
    .from(sources)
    .where(and(eq(sources.workspaceId, workspaceId), eq(sources.id, sourceId)))
    .limit(1);
  if (!source) {
    throw new ApiError(404, "SOURCE_NOT_FOUND", "That source was not found.");
  }
  return source;
}

async function requireWorkspaceGroup(
  workspaceId: string,
  groupId: string,
  db: SpecGraphDb,
) {
  const [group] = await db
    .select({ id: sourceGroups.id })
    .from(sourceGroups)
    .where(
      and(
        eq(sourceGroups.workspaceId, workspaceId),
        eq(sourceGroups.id, groupId),
      ),
    )
    .limit(1);
  if (!group) {
    throw new ApiError(
      404,
      "SOURCE_GROUP_NOT_FOUND",
      "That connected source group was not found.",
    );
  }
  return group;
}

async function membershipForSource(sourceId: string, db: SpecGraphDb) {
  const [membership] = await db
    .select({ groupId: sourceGroupMembers.groupId })
    .from(sourceGroupMembers)
    .where(eq(sourceGroupMembers.sourceId, sourceId))
    .limit(1);
  return membership || null;
}

async function memberCount(groupId: string, db: SpecGraphDb): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(sourceGroupMembers)
    .where(eq(sourceGroupMembers.groupId, groupId));
  return row?.value ?? 0;
}

async function removeEmptyGroup(groupId: string, db: SpecGraphDb): Promise<void> {
  await db.execute(sql`
    DELETE FROM ${sourceGroups}
    WHERE ${sourceGroups.id} = ${groupId}
      AND NOT EXISTS (
        SELECT 1
        FROM ${sourceGroupMembers}
        WHERE ${sourceGroupMembers.groupId} = ${groupId}
      )
  `);
}

async function createSingletonGroup(
  workspaceId: string,
  sourceId: string,
  db: SpecGraphDb,
): Promise<string> {
  const groupId = `group_${sourceId}`;
  const now = new Date().toISOString();
  await db
    .insert(sourceGroups)
    .values({
      id: groupId,
      workspaceId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: sourceGroups.id });
  await db
    .insert(sourceGroupMembers)
    .values({ workspaceId, groupId, sourceId, createdAt: now })
    .onConflictDoNothing({ target: sourceGroupMembers.sourceId });

  const membership = await membershipForSource(sourceId, db);
  if (!membership) {
    throw new ApiError(
      500,
      "SOURCE_GROUP_SETUP_FAILED",
      "The connected source group could not be saved.",
    );
  }
  if (membership.groupId !== groupId) await removeEmptyGroup(groupId, db);
  return membership.groupId;
}

async function mergeGroups(
  workspaceId: string,
  destinationGroupId: string,
  sourceGroupId: string,
  db: SpecGraphDb,
): Promise<void> {
  if (destinationGroupId === sourceGroupId) return;
  const now = new Date().toISOString();
  await db.execute(sql`
    WITH moved_members AS (
      UPDATE ${sourceGroupMembers}
      SET group_id = ${destinationGroupId}
      WHERE ${sourceGroupMembers.workspaceId} = ${workspaceId}
        AND ${sourceGroupMembers.groupId} = ${sourceGroupId}
      RETURNING source_id
    ), removed_group AS (
      DELETE FROM ${sourceGroups}
      WHERE ${sourceGroups.workspaceId} = ${workspaceId}
        AND ${sourceGroups.id} = ${sourceGroupId}
        AND EXISTS (SELECT 1 FROM moved_members)
      RETURNING id
    )
    UPDATE ${sourceGroups}
    SET updated_at = ${now}
    WHERE ${sourceGroups.workspaceId} = ${workspaceId}
      AND ${sourceGroups.id} = ${destinationGroupId}
      AND EXISTS (SELECT 1 FROM removed_group)
  `);
}

export async function ensureSourceGroup(
  workspaceId: string,
  sourceId: string,
  requestedGroupId: string | null = null,
  db: SpecGraphDb = getDb(),
): Promise<SourceGroupMembershipResult> {
  await requireWorkspaceSource(workspaceId, sourceId, db);
  const existingMembership = await membershipForSource(sourceId, db);

  if (!requestedGroupId) {
    if (existingMembership) {
      return {
        groupId: existingMembership.groupId,
        alreadyInGroup: true,
        merged: false,
      };
    }
    return {
      groupId: await createSingletonGroup(workspaceId, sourceId, db),
      alreadyInGroup: false,
      merged: false,
    };
  }

  await requireWorkspaceGroup(workspaceId, requestedGroupId, db);
  if (existingMembership?.groupId === requestedGroupId) {
    return { groupId: requestedGroupId, alreadyInGroup: true, merged: false };
  }

  if (!existingMembership) {
    await db.insert(sourceGroupMembers).values({
      workspaceId,
      groupId: requestedGroupId,
      sourceId,
      createdAt: new Date().toISOString(),
    });
    return { groupId: requestedGroupId, alreadyInGroup: false, merged: false };
  }

  const [existingSize, requestedSize] = await Promise.all([
    memberCount(existingMembership.groupId, db),
    memberCount(requestedGroupId, db),
  ]);
  if (existingSize > 1 && requestedSize > 1) {
    throw new ApiError(
      409,
      "SOURCE_GROUP_MERGE_REQUIRED",
      "That source already belongs to another connected group.",
    );
  }

  const destinationGroupId =
    existingSize > requestedSize ? existingMembership.groupId : requestedGroupId;
  const sourceGroupId =
    destinationGroupId === requestedGroupId
      ? existingMembership.groupId
      : requestedGroupId;
  await mergeGroups(workspaceId, destinationGroupId, sourceGroupId, db);
  return { groupId: destinationGroupId, alreadyInGroup: false, merged: true };
}

export async function connectSources(
  workspaceId: string,
  sourceIds: string[],
  db: SpecGraphDb = getDb(),
): Promise<{ groupId: string; alreadyTracked: boolean }> {
  const uniqueSourceIds = [...new Set(sourceIds.filter(Boolean))];
  if (uniqueSourceIds.length < 2) {
    throw new ApiError(
      400,
      "SOURCE_GROUP_INVALID",
      "Choose at least two different sources.",
    );
  }
  const rows = await db
    .select({ id: sources.id })
    .from(sources)
    .where(
      and(
        eq(sources.workspaceId, workspaceId),
        inArray(sources.id, uniqueSourceIds),
      ),
    );
  if (rows.length !== uniqueSourceIds.length) {
    throw new ApiError(404, "SOURCE_NOT_FOUND", "One of those sources was not found.");
  }

  const first = await ensureSourceGroup(workspaceId, uniqueSourceIds[0], null, db);
  let groupId = first.groupId;
  let changed = false;
  for (const sourceId of uniqueSourceIds.slice(1)) {
    const result = await ensureSourceGroup(workspaceId, sourceId, groupId, db);
    groupId = result.groupId;
    changed ||= !result.alreadyInGroup || result.merged;
  }
  return { groupId, alreadyTracked: !changed };
}

export async function sourceIdsForGroup(
  workspaceId: string,
  groupId: string,
  db: SpecGraphDb = getDb(),
): Promise<string[]> {
  await requireWorkspaceGroup(workspaceId, groupId, db);
  const rows = await db
    .select({ sourceId: sourceGroupMembers.sourceId })
    .from(sourceGroupMembers)
    .where(
      and(
        eq(sourceGroupMembers.workspaceId, workspaceId),
        eq(sourceGroupMembers.groupId, groupId),
      ),
    );
  return rows.map((row) => row.sourceId);
}

export async function sourceGroupIdForSource(
  workspaceId: string,
  sourceId: string,
  db: SpecGraphDb = getDb(),
): Promise<string | null> {
  const [membership] = await db
    .select({ groupId: sourceGroupMembers.groupId })
    .from(sourceGroupMembers)
    .where(
      and(
        eq(sourceGroupMembers.workspaceId, workspaceId),
        eq(sourceGroupMembers.sourceId, sourceId),
      ),
    )
    .limit(1);
  return membership?.groupId || null;
}

export async function sourceIdsConnectedTo(
  workspaceId: string,
  sourceIds: string[],
  db: SpecGraphDb = getDb(),
): Promise<string[]> {
  const uniqueSourceIds = [...new Set(sourceIds)];
  if (!uniqueSourceIds.length) return [];
  const memberships = await db
    .select({ groupId: sourceGroupMembers.groupId })
    .from(sourceGroupMembers)
    .where(
      and(
        eq(sourceGroupMembers.workspaceId, workspaceId),
        inArray(sourceGroupMembers.sourceId, uniqueSourceIds),
      ),
    );
  const groupIds = [...new Set(memberships.map((item) => item.groupId))];
  if (!groupIds.length) return uniqueSourceIds;
  const members = await db
    .select({ sourceId: sourceGroupMembers.sourceId })
    .from(sourceGroupMembers)
    .where(
      and(
        eq(sourceGroupMembers.workspaceId, workspaceId),
        inArray(sourceGroupMembers.groupId, groupIds),
      ),
    );
  return [...new Set([...uniqueSourceIds, ...members.map((item) => item.sourceId)])];
}

export async function removeEmptySourceGroups(
  workspaceId: string,
  db: SpecGraphDb = getDb(),
): Promise<void> {
  await db.execute(sql`
    DELETE FROM ${sourceGroups}
    WHERE ${sourceGroups.workspaceId} = ${workspaceId}
      AND NOT EXISTS (
        SELECT 1
        FROM ${sourceGroupMembers}
        WHERE ${sourceGroupMembers.groupId} = ${sourceGroups.id}
      )
  `);
}
