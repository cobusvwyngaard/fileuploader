export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  PUBLIC_RATE_LIMITER: RateLimit;
  SUBMIT_RATE_LIMITER: RateLimit;

  /** "production" or "development". Development enables the localhost-only admin bypass. */
  ENVIRONMENT: string;
  /** Canonical origin, e.g. https://uploads.example.com (no trailing slash). */
  PUBLIC_BASE_URL: string;
  /** Cloudflare Access team domain, e.g. https://example.cloudflareaccess.com */
  ACCESS_TEAM_DOMAIN: string;
  /** Application Audience (AUD) tag of the Access application protecting /admin and /api/admin. */
  ACCESS_AUD: string;
  /** Optional comma-separated allowlist of admin emails, checked after Access. */
  ADMIN_EMAILS?: string;
  /** Optional comma-separated Access service-token Client IDs allowed to call admin routes (smoke tests). */
  ADMIN_SERVICE_TOKENS?: string;
  /** Development only: email to treat as admin for requests to localhost. */
  DEV_ADMIN_EMAIL?: string;

  /** Microsoft Entra directory (tenant) ID. Single-tenant: personal accounts cannot sign in. */
  MS_TENANT_ID: string;
  /** Application (client) ID of the Entra app registration. */
  MS_CLIENT_ID: string;
  /** Secret. Client secret value of the Entra app registration. */
  MS_CLIENT_SECRET: string;
  /** Secret. Base64-encoded 32-byte key for AES-256-GCM encryption of tokens. */
  TOKEN_ENCRYPTION_KEY: string;
  /** Secret, optional. Previous key, accepted for decryption during key rotation. */
  TOKEN_ENCRYPTION_KEY_PREVIOUS?: string;
}
