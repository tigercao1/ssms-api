export const BUG_REPORT_STATUSES = [
  'new',
  'in_progress',
  'resolved',
  'wont_fix',
] as const;
export type BugReportStatus = (typeof BUG_REPORT_STATUSES)[number];

export const BUG_REPORT_SEVERITIES = ['blocked', 'wrong', 'minor'] as const;
export type BugReportSeverity = (typeof BUG_REPORT_SEVERITIES)[number];

export type BugReporterRole = 'admin' | 'instructor';

export const SCREENSHOT_EXTENSIONS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
} as const;
export type ScreenshotContentType = keyof typeof SCREENSHOT_EXTENSIONS;
export const SCREENSHOT_CONTENT_TYPES = Object.keys(
  SCREENSHOT_EXTENSIONS,
) as ScreenshotContentType[];
export const MAX_SCREENSHOT_BYTES = 3 * 1024 * 1024;

export const BUG_REPORT_LIMITS = {
  hourlyPerReporter: 10,
  perMinute: 30,
} as const;

export const SCREENSHOT_LIMITS = {
  hourlyPerReporter: 20,
  perMinute: 90,
} as const;

export interface BugReportRow {
  id: string;
  created_at: string;
  updated_at: string;
  reporter_id: string;
  reporter_name: string;
  reporter_email: string | null;
  reporter_role: BugReporterRole;
  description: string;
  expected: string | null;
  severity: BugReportSeverity | null;
  page_url: string;
  app_version: string | null;
  viewport: string | null;
  user_agent: string | null;
  screenshot_key: string | null;
  status: BugReportStatus;
  admin_note: string | null;
}

export type NewBugReport = Omit<
  BugReportRow,
  'id' | 'created_at' | 'updated_at' | 'status' | 'admin_note'
>;

export type LimitedBy = 'reporter' | 'global';

export type SubmitOutcome =
  | { id: string; createdAt: string }
  | { limited: LimitedBy };

export interface BugReportItem {
  id: string;
  createdAt: string;
  status: BugReportStatus;
  severity: BugReportSeverity | null;
  description: string;
  expected: string | null;
  reporter: {
    id: string;
    name: string;
    email: string | null;
    role: BugReporterRole;
  };
  pageUrl: string;
  hasScreenshot: boolean;
}

export interface BugReportDetail extends BugReportItem {
  appVersion: string | null;
  viewport: string | null;
  userAgent: string | null;
  adminNote: string | null;
  updatedAt: string;
  screenshotUrl: string | null;
}

export interface ScreenshotUploadUrl {
  uploadUrl: string;
  key: string;
  expiresAt: string;
}
