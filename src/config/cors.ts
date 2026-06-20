import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

/**
 * CORS for the authenticated portal (PORTAL_EXECUTION_PLAN.md W0.5).
 *
 * v1 posture is **deny all browser origins** (RLS_AND_SECURITY_PLAN.md § CORS):
 * the public API is server-to-server and needs no browser access. The
 * instructor/admin portal is the one browser client, so we open CORS **only**
 * to an explicit allow-list provided via `CORS_ALLOWED_ORIGINS` (comma-
 * separated). When the var is unset/empty, CORS stays off and the deny-all
 * default is preserved.
 *
 * The portal authenticates with a Bearer JWT (not cookies), so `credentials`
 * stays `false` — we only need to allow the `Authorization` + `Content-Type`
 * headers and the methods the API actually uses.
 */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export function buildCorsOptions(origins: string[]): CorsOptions {
  return {
    origin: origins,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    credentials: false,
    maxAge: 86400, // cache preflight for 24h
  };
}
