/**
 * Shape of a UI/API message catalog (one per shipped language).
 *
 * v1 ships `en` (source of truth, see `en/`) and `zh-CN` (`zh-CN/`). Both files
 * are typed as {@link MessageCatalog}, so TypeScript guarantees zh-CN mirrors
 * every English key at compile time (satisfies T9.2 acceptance). Missing keys
 * fall back to English at runtime via the loader (see `index.ts`).
 *
 * Scope (per PORTAL_I18N_PLAN.md): instructor-portal UI strings + API error
 * messages returned to authenticated users, plus transactional notification copy
 * consumed by the Notifications module (T8.2). It does NOT cover reference-data
 * labels or public-API responses — those use the `key` + fallback pattern
 * documented in LOCALIZATION_EXAMPLE.md / LOCALIZATION_STRATEGY.md.
 */
export interface MessageCatalog {
  /** Generic, app-wide strings (brand, shared buttons, shared statuses). */
  common: CommonMessages;
  /** Auth / login / verification flow copy. */
  auth: AuthMessages;
  /** Instructor profile screen copy. */
  profile: ProfileMessages;
  /** Stable API/validation error messages keyed by error code. */
  error: ErrorMessages;
  /** Form validation copy (interpolation tokens in `{braces}`). */
  validation: ValidationMessages;
  /** Empty-state copy for lists/sections. */
  emptyState: EmptyStateMessages;
  /**
   * Transactional email copy, one block per admin action. Consumed by the
   * Notifications module's template renderer (T8.2). Keep field names in sync
   * with `src/mailer` `NotificationType` ('approved' | 'rejected' | 'deactivated').
   */
  notification: NotificationMessages;
}

export interface CommonMessages {
  appName: string;
  portal: string;
  loading: string;
  save: string;
  cancel: string;
  edit: string;
  delete: string;
  confirm: string;
  back: string;
  next: string;
  submit: string;
  search: string;
  yes: string;
  no: string;
  /** Language switcher labels. */
  language: string;
  languageEnglish: string;
  languageChinese: string;
  /** Shared instructor status labels (UI display of approval_status). */
  statusPending: string;
  statusApproved: string;
  statusRejected: string;
  statusDeactivated: string;
}

export interface AuthMessages {
  signInTitle: string;
  signUpTitle: string;
  emailLabel: string;
  passwordLabel: string;
  signInButton: string;
  signUpButton: string;
  signOut: string;
  forgotPassword: string;
  verifyEmailTitle: string;
  verifyEmailBody: string;
  resendVerification: string;
  emailNotVerified: string;
}

export interface ProfileMessages {
  title: string;
  displayName: string;
  bio: string;
  bioPlaceholder: string;
  preferredLanguage: string;
  dateOfBirth: string;
  certifications: string;
  disciplines: string;
  teachingLocations: string;
  courseLevels: string;
  photo: string;
  uploadPhoto: string;
  saveSuccess: string;
  saveError: string;
}

export interface ErrorMessages {
  /** error.unauthorized */
  unauthorized: string;
  /** error.forbidden */
  forbidden: string;
  /** error.notFound */
  notFound: string;
  /** error.validation (generic 400) */
  validation: string;
  /** error.conflict */
  conflict: string;
  /** error.rateLimited */
  rateLimited: string;
  /** error.internal (500) */
  internal: string;
  /** error.emailNotVerified */
  emailNotVerified: string;
  /** error.profileNotApproved */
  profileNotApproved: string;
}

export interface ValidationMessages {
  required: string;
  email: string;
  /** Uses `{min}`. */
  minLength: string;
  /** Uses `{max}`. */
  maxLength: string;
  invalidDate: string;
  invalidLanguage: string;
  invalidUuid: string;
}

export interface EmptyStateMessages {
  noCertifications: string;
  noDisciplines: string;
  noLocations: string;
  noResults: string;
}

export interface NotificationMessages {
  approved: NotificationCopy;
  rejected: NotificationCopy;
  deactivated: NotificationCopy;
}

/**
 * Copy for a single transactional email. Field names mirror the existing
 * built-in renderer in `src/mailer/default-notification-renderer.ts` so the
 * Notifications module (T8.2) can read these catalogs without reshaping copy.
 */
export interface NotificationCopy {
  subject: string;
  greeting: string;
  body: string;
  /** Label preceding a rejection reason (rejected only). */
  reasonLabel: string;
  /** Label preceding the portal URL (approved only). */
  linkLabel: string;
  signoff: string;
}

/** Languages shipped in v1. Mirrors the instructor profile `preferred_language`. */
export type SupportedLanguage = 'en' | 'zh-CN';

/** Default language when an instructor has no `preferred_language`. */
export const DEFAULT_LANGUAGE: SupportedLanguage = 'en';
