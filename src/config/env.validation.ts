/**
 * Fail-fast environment validation, run by ConfigModule at boot.
 * Keeps required Supabase config explicit (see backend-architecture.md §1,§6).
 *
 * Auth uses the asymmetric ES256 JWT signing key verified via JWKS, so no
 * shared JWT secret is required. The JWKS URL is derived from SUPABASE_URL
 * (override with SUPABASE_JWKS_URL).
 */
const REQUIRED_ENV = [
  'SUPABASE_URL',
  // New-style secret API key (`sb_secret_...`), replaces the legacy
  // service_role key. Server-only; bypasses RLS by design.
  'SUPABASE_SECRET_KEY',
  'SUPABASE_STORAGE_BUCKET',
] as const;

export function validateEnv(config: Record<string, unknown>) {
  const missing = REQUIRED_ENV.filter(
    (key) => config[key] === undefined || config[key] === '',
  );
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
        'See .env.example.',
    );
  }
  return config;
}
