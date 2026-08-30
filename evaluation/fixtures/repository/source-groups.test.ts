import { addEqualSourceMember } from "./source-groups";

export function verifiesDocumentationFirstAndRepositoryFirst() {
  return addEqualSourceMember({ id: "group", sourceIds: ["documentation"] }, "repository");
}
