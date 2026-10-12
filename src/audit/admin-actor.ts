import type { AuditActor } from '../audit/audit.types';
import type { SupabaseJwtPayload } from '../auth/jwt-payload.interface';

export function toActor(
  user: SupabaseJwtPayload,
  userAgent?: string,
): AuditActor {
  return { userId: user.sub, role: 'admin', userAgent: userAgent ?? null };
}
