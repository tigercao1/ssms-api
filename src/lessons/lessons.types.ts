export const CLASS_STATUSES = [
  'scheduled',
  'completed',
  'no_show',
  'cancelled',
] as const;
export type ClassStatus = (typeof CLASS_STATUSES)[number];
export type ClassSource = 'ssms' | 'app_import' | 'app_webhook';
export type Attendance = 'expected' | 'attended' | 'no_show';
export type GoogleSyncStatus = 'ok' | 'pending' | 'failed';
export const CLASS_SORTS = ['startsAt', 'createdAt'] as const;
export type ClassSort = (typeof CLASS_SORTS)[number];
