export interface GoogleConnectionRow {
  account_email: string;
  refresh_token_enc: string | null;
  scopes: string[];
  connected_at: string;
  connected_by: string | null;
  last_refresh_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
}

export interface GoogleConnectionStatus {
  configured: boolean;
  connected: boolean;
  accountEmail: string | null;
  scopes: string[];
  connectedAt: string | null;
  lastError: string | null;
}

export type GoogleAccessRole =
  | 'freeBusyReader'
  | 'reader'
  | 'writer'
  | 'owner'
  | (string & {});

export interface GoogleCalendar {
  id: string;
  summary: string;
  accessRole: GoogleAccessRole;
}

export interface AdminGoogleCalendar extends GoogleCalendar {
  canWrite: boolean;
}

export interface BusyInterval {
  start: string;
  end: string;
}

export interface FreeBusyError {
  domain: string;
  reason: string;
}

export interface CalendarFreeBusy {
  id: string;
  busy: BusyInterval[];
  errors: FreeBusyError[];
}

export interface FreeBusyResult {
  timeMin: string;
  timeMax: string;
  calendars: CalendarFreeBusy[];
}

export type GoogleEventTime =
  | { dateTime: string; timeZone?: string }
  | { date: string };

export interface GoogleEventInput {
  summary?: string;
  description?: string;
  location?: string;
  start?: GoogleEventTime;
  end?: GoogleEventTime;
  ssmsClassId?: string;
}

export interface GoogleEvent {
  id: string;
  status: string | null;
  htmlLink: string | null;
  summary: string | null;
  start: GoogleEventTime | null;
  end: GoogleEventTime | null;
  ssmsClassId: string | null;
}
