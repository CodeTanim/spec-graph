export function impactedContractDocumentation(change: {
  operation?: string;
  schema?: string;
  requestField?: string;
  responseField?: string;
}) {
  return { ...change, restrictToMatchingContractEntity: true };
}
