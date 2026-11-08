export const ADMIN_API_TOKEN_CLOCK = Symbol('ADMIN_API_TOKEN_CLOCK');
export const ADMIN_API_TOKEN_RATE_LIMITER = Symbol(
  'ADMIN_API_TOKEN_RATE_LIMITER',
);

export interface AdminApiTokenClock {
  now(): number;
}

export interface AdminApiTokenRow {
  id: string;
  owner_user_id: string;
  name: string;
  token_prefix: string;
  token_last4: string;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  replaced_by: string | null;
  grace_until: string | null;
}

export type AdminApiTokenStatus = 'active' | 'expired' | 'revoked' | 'rotating';

export interface AdminApiTokenSummary {
  id: string;
  name: string;
  prefix: string;
  last4: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  status: AdminApiTokenStatus;
}

export interface IssuedAdminApiToken {
  id: string;
  name: string;
  token: string;
  prefix: string;
  last4: string;
  createdAt: string;
  expiresAt: string | null;
}

export function tokenStatus(
  row: AdminApiTokenRow,
  now: number,
): AdminApiTokenStatus {
  if (row.revoked_at !== null) {
    return 'revoked';
  }
  if (row.expires_at !== null && Date.parse(row.expires_at) <= now) {
    return 'expired';
  }
  if (row.replaced_by !== null) {
    return row.grace_until !== null && Date.parse(row.grace_until) > now
      ? 'rotating'
      : 'revoked';
  }
  return 'active';
}
