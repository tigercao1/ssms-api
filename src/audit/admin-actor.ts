import type { AuditActor } from '../audit/audit.types';
import type { SupabaseJwtPayload } from '../auth/jwt-payload.interface';

export function toActor(
  user: SupabaseJwtPayload,
  userAgent?: string,
): AuditActor {
  const actor: AuditActor = {
    userId: user.sub,
    role: 'admin',
    userAgent: userAgent ?? null,
  };
  if (user.auth_via === 'api_token') {
    actor.via = 'api_token';
    actor.tokenId = user.token_id ?? null;
  }
  return actor;
}
