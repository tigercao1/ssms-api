/**
 * T6.8 — Audit log contract.
 *
 * Single append-only table (`audit_log`); security-relevant actions only — the
 * canonical list is locked in RLS_AND_SECURITY_PLAN.md § What to log. Routine
 * reads and instructor self-edits are intentionally NOT audited.
 */

/** Every security-relevant action v1 may append. Keep in sync with the plan. */
export const AUDIT_ACTIONS = {
  instructorApprove: 'instructor.approve',
  instructorReject: 'instructor.reject',
  instructorActivate: 'instructor.activate',
  instructorDeactivate: 'instructor.deactivate',
  // Emitted by PATCH /admin/users/:id/role (AdminService.setUserRole).
  userRoleChange: 'user.role_change',
  userInvite: 'user.invite',
  apiKeyCreate: 'api_key.create',
  apiKeyRevoke: 'api_key.revoke',
  apiKeyRotate: 'api_key.rotate',
  authAdminGuardFailure: 'auth.admin_guard_failure',
  systemBootstrapAdmin: 'system.bootstrap_admin',
  notificationFailure: 'notification.failure',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/** Who performed the action; `null`/`system` for unauthenticated/system flows. */
export type AuditActorRole = 'admin' | 'instructor' | 'system';

/** Identifying context for the actor, threaded from the request layer. */
export interface AuditActor {
  /** `auth.users.id` (JWT `sub`); null for system / bootstrap. */
  userId?: string | null;
  role?: AuditActorRole | null;
  userAgent?: string | null;
  /** Client IP, if the caller resolved it. */
  ip?: string | null;
}

/** A single row to append to `audit_log`. */
export interface AuditEntry {
  action: AuditAction;
  actor?: AuditActor | null;
  targetType?: 'instructor' | 'user' | 'api_key' | null;
  targetId?: string | null;
  metadata?: Record<string, unknown> | null;
}
