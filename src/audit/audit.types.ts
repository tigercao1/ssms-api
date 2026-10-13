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
  instructorDisplayOrderUpdate: 'instructor.display_order_update',
  // Emitted by PATCH /admin/users/:id/role (AdminService.setUserRole).
  userRoleChange: 'user.role_change',
  userInvite: 'user.invite',
  referenceUpdate: 'reference.update',
  referenceDelete: 'reference.delete',
  apiKeyCreate: 'api_key.create',
  apiKeyRevoke: 'api_key.revoke',
  apiKeyRotate: 'api_key.rotate',
  authAdminGuardFailure: 'auth.admin_guard_failure',
  systemBootstrapAdmin: 'system.bootstrap_admin',
  notificationFailure: 'notification.failure',
  shopifySyncEnable: 'shopify_sync.enable',
  shopifySyncDisable: 'shopify_sync.disable',
  shopifySyncRun: 'shopify_sync.run',
  pageCreate: 'page.create',
  pageUpdate: 'page.update',
  pageUpload: 'page.upload',
  pagePublish: 'page.publish',
  pageUnpublish: 'page.unpublish',
  pageDelete: 'page.delete',
  pageStorageInconsistent: 'page.storage_inconsistent',
  googleConnect: 'google.connect',
  googleConnectRejected: 'google.connect_rejected',
  googleDisconnect: 'google.disconnect',
  googleTokenInvalid: 'google.token_invalid',
  instructorGoogleCalendarUpdate: 'instructor.google_calendar_update',
  instructorGoogleCalendarSuggest: 'instructor.google_calendar_suggest',
  lessonTypeCreate: 'lesson_type.create',
  lessonTypeUpdate: 'lesson_type.update',
  payRateCreate: 'pay_rate.create',
  payRateUpdate: 'pay_rate.update',
  customerSync: 'customer.sync',
  customerCreate: 'customer.create',
  bookingClassCreate: 'booking.class_create',
  bookingClassUpdate: 'booking.class_update',
  bookingClassCancel: 'booking.class_cancel',
  bookingClassStatus: 'booking.class_status',
  bookingClassSyncRetry: 'booking.class_sync_retry',
  bookingSettingsUpdate: 'booking.settings_update',
  payrollSettingsUpdate: 'payroll.settings_update',
  payrollAdjustmentCreate: 'payroll.adjustment_create',
  payrollAdjustmentDelete: 'payroll.adjustment_delete',
  payrollFinalize: 'payroll.finalize',
  payrollReopen: 'payroll.reopen',
  classImportCreate: 'class_import.create',
  classImportRowUpdate: 'class_import.row_update',
  classImportEventMapUpdate: 'class_import.event_map_update',
  classImportCommit: 'class_import.commit',
  classImportDiscard: 'class_import.discard',
  documentTemplateCreate: 'document_template.create',
  documentTemplateUpdate: 'document_template.update',
  documentTemplateSourceReplace: 'document_template.source_replace',
  documentTemplateFieldsUpdate: 'document_template.fields_update',
  documentAssignmentCreate: 'document_assignment.create',
  documentAssignmentArchive: 'document_assignment.archive',
  documentAssignmentRemind: 'document_assignment.remind',
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
  targetType?:
    | 'instructor'
    | 'user'
    | 'api_key'
    | 'reference'
    | 'public_page'
    | 'google_connection'
    | 'lesson_type'
    | 'pay_rate'
    | 'customer'
    | 'class'
    | 'booking_settings'
    | 'payroll_period'
    | 'payroll_settings'
    | 'class_import'
    | 'document_template'
    | 'document_assignment'
    | null;
  targetId?: string | null;
  metadata?: Record<string, unknown> | null;
}
