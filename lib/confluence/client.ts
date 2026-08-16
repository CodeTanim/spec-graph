import type {
  ConfluenceAccessibleResource,
  ConfluenceOAuthToken,
  ConfluencePage,
  ConfluenceSpace,
} from "./types";
import type { ConfluenceConfig } from "./config";
import { ApiError } from "../server/http";

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
};

type PageResponse = {
  results?: Array<{
    id?: string;
    title?: string;
    spaceId?: string;
    body?: { storage?: { value?: string } };
    version?: { number?: number };
    _links?: { webui?: string };
  }>;
};

export interface ConfluenceSourceProvider {
  exchangeOAuthCode(code: string, redirectUri: string): Promise<ConfluenceOAuthToken>;
  refreshOAuthToken(refreshToken: string): Promise<ConfluenceOAuthToken>;
  accessibleResources(accessToken: string): Promise<ConfluenceAccessibleResource[]>;
  spaces(accessToken: string, cloudId: string): Promise<ConfluenceSpace[]>;
  pages(accessToken: string, cloudId: string, spaceId: string): Promise<ConfluencePage[]>;
}

export class ConfluenceClient implements ConfluenceSourceProvider {
  constructor(private readonly config: ConfluenceConfig) {}

  private async token(body: Record<string, string>): Promise<ConfluenceOAuthToken> {
    const response = await fetch("https://auth.atlassian.com/oauth/token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        ...body,
      }),
    });
    const payload = (await response.json().catch(() => null)) as TokenResponse | null;
    if (!response.ok || !payload?.access_token) {
      throw new ApiError(502, "CONFLUENCE_TOKEN_FAILED", "Confluence authorization could not be completed.");
    }
    return {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token || null,
      expiresIn: payload.expires_in || 3600,
      scope: payload.scope || "",
    };
  }

  exchangeOAuthCode(code: string, redirectUri: string) {
    return this.token({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
  }

  refreshOAuthToken(refreshToken: string) {
    return this.token({ grant_type: "refresh_token", refresh_token: refreshToken });
  }

  async accessibleResources(accessToken: string): Promise<ConfluenceAccessibleResource[]> {
    const response = await fetch("https://api.atlassian.com/oauth/token/accessible-resources", {
      headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
    });
    const payload = (await response.json().catch(() => null)) as ConfluenceAccessibleResource[] | null;
    if (!response.ok || !Array.isArray(payload)) {
      throw new ApiError(502, "CONFLUENCE_SITES_FAILED", "Confluence sites could not be loaded.");
    }
    return payload.filter((item) => item.id && item.name && item.url);
  }

  async spaces(accessToken: string, cloudId: string): Promise<ConfluenceSpace[]> {
    const response = await this.api(accessToken, cloudId, "/wiki/api/v2/spaces?limit=100");
    const payload = (await response.json().catch(() => null)) as { results?: ConfluenceSpace[] } | null;
    if (!response.ok || !Array.isArray(payload?.results)) {
      throw new ApiError(502, "CONFLUENCE_SPACES_FAILED", "Confluence spaces could not be loaded.");
    }
    return payload.results.filter((item) => item.id && item.key && item.name);
  }

  async pages(
    accessToken: string,
    cloudId: string,
    spaceId: string,
  ): Promise<ConfluencePage[]> {
    const response = await this.api(
      accessToken,
      cloudId,
      `/wiki/api/v2/spaces/${encodeURIComponent(spaceId)}/pages?limit=100&body-format=storage`,
    );
    const payload = (await response.json().catch(() => null)) as PageResponse | null;
    if (!response.ok || !Array.isArray(payload?.results)) {
      throw new ApiError(502, "CONFLUENCE_PAGES_FAILED", "Confluence pages could not be loaded.");
    }
    return payload.results.flatMap((item) =>
      item.id && item.title && item.spaceId
        ? [{
            id: item.id,
            title: item.title,
            spaceId: item.spaceId,
            bodyStorage: item.body?.storage?.value || "",
            version: item.version?.number || 1,
            webPath: item._links?.webui || null,
          }]
        : [],
    );
  }

  private api(accessToken: string, cloudId: string, path: string): Promise<Response> {
    return fetch(`https://api.atlassian.com/ex/confluence/${encodeURIComponent(cloudId)}${path}`, {
      headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
    });
  }
}
