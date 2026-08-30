export function ingestRepositoryChange(
  deliveryId: string,
  revision: string,
  signatureVerified: boolean,
) {
  return {
    deliveryId,
    revision,
    signatureVerified,
    duplicateDelivery: false,
    automaticAnalysis: true,
  };
}
