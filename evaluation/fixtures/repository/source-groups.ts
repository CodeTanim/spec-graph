export type LocalSourceGroup = {
  id: string;
  sourceIds: string[];
};

export function addEqualSourceMember(group: LocalSourceGroup, sourceId: string) {
  return { ...group, sourceIds: [...new Set([...group.sourceIds, sourceId])] };
}
