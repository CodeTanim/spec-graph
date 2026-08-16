declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    GITHUB_APP_SLUG?: string;
    GITHUB_CLIENT_ID?: string;
    GITHUB_CLIENT_SECRET?: string;
    GITHUB_APP_ID?: string;
    GITHUB_PRIVATE_KEY?: string;
  }
}

declare module "*.sql?raw" {
  const sql: string;
  export default sql;
}
