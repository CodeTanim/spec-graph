# GitHub App Setup

SpecGraph uses one GitHub App for user authorization and short-lived installation access. GitHub user and installation tokens are never stored in D1.

## Register the app

Create a GitHub App from **Settings → Developer settings → GitHub Apps** with:

- Homepage URL: `https://specgraph-mvp.codetanim.chatgpt.site`
- Callback URL: `https://specgraph-mvp.codetanim.chatgpt.site/api/github/callback`
- Request user authorization during installation: enabled
- Webhooks: active
- Webhook URL: `https://specgraph-mvp.codetanim.chatgpt.site/api/github/webhook`
- Webhook secret: a new random value stored as `GITHUB_WEBHOOK_SECRET` in the SpecGraph runtime
- Subscribe to events: **Push** and **Pull request**
- Repository permissions:
  - Contents: read-only
  - Pull requests: read-only
  - Metadata: read-only (GitHub supplies this automatically)

The app can be private while SpecGraph is owner-only. Install it on a small demonstration repository and grant access only to the repository you intend to index.

GitHub references:

- [Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app)
- [Generating a user access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
- [Generating an installation access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)

## Configure SpecGraph

Add these values to `.env` for local development and to the Sites runtime environment for the deployed app:

| Variable | GitHub App value |
| --- | --- |
| `GITHUB_APP_SLUG` | The slug shown in the app's public URL |
| `GITHUB_CLIENT_ID` | Client ID |
| `GITHUB_CLIENT_SECRET` | Client secret |
| `GITHUB_APP_ID` | Numeric App ID |
| `GITHUB_PRIVATE_KEY` | Complete downloaded PEM private key |
| `GITHUB_WEBHOOK_SECRET` | The exact secret entered in the GitHub App webhook settings |

Keep the client secret, private key, and webhook secret out of source control. `GITHUB_PRIVATE_KEY` may contain real newlines or escaped `\\n` sequences. The webhook secret must match exactly in GitHub and the deployed runtime; changing one side without the other causes every delivery to be rejected.

## Current indexing boundary

The walking skeleton indexes up to 60 supported files and 4 MB total per repository. Individual files are capped at 160 KB. Supported artifacts are:

- TypeScript and JavaScript code
- TypeScript and JavaScript tests
- Markdown and MDX documentation
- OpenAPI or Swagger JSON, YAML, and YML files using conventional filenames

Generated, dependency, coverage, build, and binary files are excluded. A manual GitHub analysis target must be a pull-request number such as `#42` or a pull-request URL for the connected repository. Automatic analysis accepts pushes to the tracked branch plus opened, reopened, synchronized, and ready-for-review pull requests targeting that branch.
