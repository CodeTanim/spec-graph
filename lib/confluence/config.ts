import { ApiError } from "../server/http";

export type ConfluenceConfig = {
  clientId: string;
  clientSecret: string;
  encryptionKey: string;
};

function value(name: string): string {
  return process.env[name]?.trim() ?? "";
}

export function getConfluenceConfig(): ConfluenceConfig {
  const clientId = value("CONFLUENCE_CLIENT_ID");
  const clientSecret = value("CONFLUENCE_CLIENT_SECRET");
  const encryptionKey = value("CONNECTOR_ENCRYPTION_KEY");
  if (!clientId || !clientSecret || !encryptionKey) {
    throw new ApiError(
      503,
      "CONFLUENCE_NOT_CONFIGURED",
      "Confluence connection is not configured yet.",
    );
  }
  return { clientId, clientSecret, encryptionKey };
}

export const CONFLUENCE_SCOPES = [
  "read:space:confluence",
  "read:page:confluence",
  "offline_access",
].join(" ");
