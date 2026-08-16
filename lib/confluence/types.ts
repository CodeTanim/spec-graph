export type ConfluenceOAuthToken = {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
  scope: string;
};

export type ConfluenceAccessibleResource = {
  id: string;
  name: string;
  url: string;
  scopes: string[];
};

export type ConfluenceSpace = {
  id: string;
  key: string;
  name: string;
};

export type ConfluencePage = {
  id: string;
  title: string;
  spaceId: string;
  bodyStorage: string;
  version: number;
  webPath: string | null;
};
