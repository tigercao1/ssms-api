/**
 * Shape of a verified Supabase access-token payload we rely on.
 * Tokens are signed with the asymmetric ES256 JWT signing key and verified
 * against the project JWKS (see supabase-jwt.strategy.ts).
 */
export interface SupabaseJwtPayload {
  /** auth.users.id — matches instructors.auth_user_id */
  sub: string;
  email?: string;
  /** Present on Supabase tokens; null/absent until email verified. */
  email_confirmed_at?: string | null;
  /** Server-set only. role === 'admin' grants admin access (see ADMIN_ROLE_PLAN.md). */
  app_metadata?: { role?: string; [key: string]: unknown };
  user_metadata?: { email_verified?: boolean; [key: string]: unknown };
  aud?: string;
  exp?: number;
}

/** What request.user is after the guard runs. */
export type CurrentUserContext = SupabaseJwtPayload;
