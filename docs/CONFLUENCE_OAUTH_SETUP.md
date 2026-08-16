# Confluence OAuth setup

Package 3 implements the Confluence OAuth 2.0 (3LO) and read-only ingestion flow. Production activation is intentionally waiting for the replacement hosting domain.

## Atlassian app

Create an OAuth 2.0 integration in the Atlassian developer console and enable these scopes:

- `read:space:confluence`
- `read:page:confluence`
- `offline_access`

Register one exact callback URL:

```text
https://YOUR_FINAL_DOMAIN/api/confluence/callback
```

Do not register the temporary Sites address as the production callback. For local end-to-end testing, use a stable HTTPS tunnel and add its exact callback separately.

## Runtime secrets

Configure these values in the replacement host's secret store:

```text
CONFLUENCE_CLIENT_ID
CONFLUENCE_CLIENT_SECRET
CONNECTOR_ENCRYPTION_KEY
```

`CONNECTOR_ENCRYPTION_KEY` must be a base64-encoded 32-byte random value. SpecGraph uses it with AES-GCM before any access or refresh token is written to the database. Never commit any of these values.

## Implemented flow

1. The server creates an expiring, workspace-scoped state record.
2. Atlassian authorizes read-only access and returns to the callback.
3. The server exchanges the code, discovers accessible Confluence sites and spaces, and encrypts the rotating tokens.
4. The user chooses a space; SpecGraph stores its canonical cloud/space identity and optionally pairs it with a repository.
5. Initial sync indexes up to 100 readable pages with their IDs, versions, text, and canonical links.

References: [Atlassian OAuth 2.0 (3LO)](https://developer.atlassian.com/cloud/confluence/oauth-2-3lo-apps/), [Confluence spaces API](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-space/), and [Confluence pages API](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/).
