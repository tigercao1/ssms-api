import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ACTIONS } from '../audit/audit.types';
import {
  GoogleApiError,
  GoogleAuthError,
  GoogleNotConnectedError,
} from './google.errors';
import type {
  CalendarFreeBusy,
  FreeBusyResult,
  GoogleCalendar,
  GoogleEvent,
  GoogleEventInput,
  GoogleEventTime,
} from './google.types';
import { GoogleConnectionRepository } from './google-connection.repository';
import {
  errorMessage,
  errorReason,
  readErrorBody,
  sendWithRetry,
} from './google-http';
import { GoogleOAuthClient } from './google-oauth.client';
import {
  defaultGoogleRuntime,
  GOOGLE_RUNTIME,
  type GoogleRuntime,
} from './google-runtime';
import { decryptToken, TokenDecryptError } from './token-cipher';

export const GOOGLE_CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
export const FREEBUSY_BATCH_SIZE = 50;
export const CALENDAR_LIST_PAGE_SIZE = 250;
export const CALENDAR_LIST_MAX_PAGES = 40;
export const ACCESS_TOKEN_REFRESH_MARGIN_MS = 60_000;
export const INVALID_GRANT = 'invalid_grant';

const EVENT_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuv';

interface CachedToken {
  value: string;
  refreshAt: number;
}

interface CalendarListResponse {
  items?: {
    id: string;
    summary?: string;
    summaryOverride?: string;
    accessRole: string;
  }[];
  nextPageToken?: string;
}

interface FreeBusyResponse {
  calendars?: Record<
    string,
    {
      busy?: { start: string; end: string }[];
      errors?: { domain: string; reason: string }[];
    }
  >;
}

interface EventResource {
  id: string;
  status?: string;
  htmlLink?: string;
  summary?: string;
  start?: GoogleEventTime;
  end?: GoogleEventTime;
  extendedProperties?: { private?: Record<string, string> };
}

interface ApiRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, string>;
  body?: unknown;
}

interface ApiResponse<T> {
  status: number;
  attempts: number;
  body: T | undefined;
}

@Injectable()
export class GoogleCalendarClient {
  private readonly logger = new Logger(GoogleCalendarClient.name);
  private readonly runtime: GoogleRuntime;
  private token?: CachedToken;
  private pendingToken?: Promise<CachedToken>;

  constructor(
    private readonly oauth: GoogleOAuthClient,
    private readonly connections: GoogleConnectionRepository,
    @Optional()
    @Inject(GOOGLE_RUNTIME)
    runtime?: Partial<GoogleRuntime>,
    @Optional() private readonly audit?: AuditService,
  ) {
    this.runtime = { ...defaultGoogleRuntime, ...runtime };
  }

  async isConnected(): Promise<boolean> {
    if (!this.oauth.isConfigured()) {
      return false;
    }
    const row = await this.connections.get();
    return Boolean(row?.refresh_token_enc);
  }

  invalidate(): void {
    this.token = undefined;
  }

  async listCalendars(): Promise<GoogleCalendar[]> {
    const calendars: GoogleCalendar[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < CALENDAR_LIST_MAX_PAGES; page++) {
      const query: Record<string, string> = {
        maxResults: String(CALENDAR_LIST_PAGE_SIZE),
      };
      if (pageToken) {
        query.pageToken = pageToken;
      }
      const { body } = await this.api<CalendarListResponse>({
        method: 'GET',
        path: '/users/me/calendarList',
        query,
      });
      for (const item of body?.items ?? []) {
        calendars.push({
          id: item.id,
          summary: item.summaryOverride ?? item.summary ?? item.id,
          accessRole: item.accessRole,
        });
      }
      pageToken = body?.nextPageToken;
      if (!pageToken) {
        break;
      }
    }
    return calendars;
  }

  async freeBusy(
    calendarIds: string[],
    timeMin: string,
    timeMax: string,
  ): Promise<FreeBusyResult> {
    const ids = [...new Set(calendarIds)];
    const batches: string[][] = [];
    for (let i = 0; i < ids.length; i += FREEBUSY_BATCH_SIZE) {
      batches.push(ids.slice(i, i + FREEBUSY_BATCH_SIZE));
    }
    const responses = await Promise.all(
      batches.map((batch) =>
        this.api<FreeBusyResponse>({
          method: 'POST',
          path: '/freeBusy',
          body: { timeMin, timeMax, items: batch.map((id) => ({ id })) },
        }),
      ),
    );
    const merged = new Map<string, CalendarFreeBusy>();
    for (const { body } of responses) {
      for (const [id, entry] of Object.entries(body?.calendars ?? {})) {
        merged.set(id, {
          id,
          busy: (entry.busy ?? []).map(({ start, end }) => ({ start, end })),
          errors: (entry.errors ?? []).map(({ domain, reason }) => ({
            domain,
            reason,
          })),
        });
      }
    }
    return {
      timeMin,
      timeMax,
      calendars: ids.map(
        (id) =>
          merged.get(id) ?? {
            id,
            busy: [],
            errors: [{ domain: 'ssms', reason: 'missingFromResponse' }],
          },
      ),
    };
  }

  async insertEvent(
    calendarId: string,
    event: GoogleEventInput,
    options: { eventId?: string } = {},
  ): Promise<GoogleEvent> {
    const eventId = options.eventId ?? newEventId();
    const { status, attempts, body } = await this.api<EventResource>(
      {
        method: 'POST',
        path: eventsPath(calendarId),
        body: { id: eventId, ...toEventBody(event) },
      },
      [409],
    );
    if (status === 409 && attempts > 1) {
      return this.getEvent(calendarId, eventId);
    }
    if (status === 409) {
      throw new GoogleApiError(409, 'duplicate', 'Event id already exists');
    }
    return toEvent(body as EventResource);
  }

  async patchEvent(
    calendarId: string,
    eventId: string,
    patch: GoogleEventInput,
  ): Promise<GoogleEvent> {
    const { body } = await this.api<EventResource>({
      method: 'PATCH',
      path: `${eventsPath(calendarId)}/${encodeURIComponent(eventId)}`,
      body: toEventBody(patch),
    });
    return toEvent(body as EventResource);
  }

  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    await this.api(
      {
        method: 'DELETE',
        path: `${eventsPath(calendarId)}/${encodeURIComponent(eventId)}`,
      },
      [404, 410],
    );
  }

  private async getEvent(
    calendarId: string,
    eventId: string,
  ): Promise<GoogleEvent> {
    const { body } = await this.api<EventResource>({
      method: 'GET',
      path: `${eventsPath(calendarId)}/${encodeURIComponent(eventId)}`,
    });
    return toEvent(body as EventResource);
  }

  private async api<T>(
    request: ApiRequest,
    allowedStatuses: number[] = [],
  ): Promise<ApiResponse<T>> {
    const url = new URL(`${GOOGLE_CALENDAR_API}${request.path}`);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      url.searchParams.set(key, value);
    }
    let retriedUnauthorized = false;
    for (;;) {
      const token = await this.accessToken();
      let result: Awaited<ReturnType<typeof sendWithRetry>>;
      try {
        result = await sendWithRetry(this.runtime, url.toString(), () => ({
          method: request.method,
          headers: {
            Authorization: `Bearer ${token.value}`,
            Accept: 'application/json',
            ...(request.body === undefined
              ? {}
              : { 'Content-Type': 'application/json' }),
          },
          body:
            request.body === undefined
              ? undefined
              : JSON.stringify(request.body),
        }));
      } catch (err) {
        throw new GoogleApiError(undefined, undefined, (err as Error).message);
      }
      const { response, attempts } = result;
      if (response.status === 401 && !retriedUnauthorized) {
        retriedUnauthorized = true;
        if (this.token === token) {
          this.token = undefined;
        }
        continue;
      }
      if (allowedStatuses.includes(response.status)) {
        return { status: response.status, attempts, body: undefined };
      }
      if (!response.ok) {
        const body = await readErrorBody(response);
        throw new GoogleApiError(
          response.status,
          errorReason(body),
          errorMessage(body),
        );
      }
      if (response.status === 204) {
        return { status: response.status, attempts, body: undefined };
      }
      const text = await response.text();
      return {
        status: response.status,
        attempts,
        body: text === '' ? undefined : (JSON.parse(text) as T),
      };
    }
  }

  private async accessToken(): Promise<CachedToken> {
    if (this.token && this.runtime.now() < this.token.refreshAt) {
      return this.token;
    }
    this.pendingToken ??= this.refreshAccessToken().finally(() => {
      this.pendingToken = undefined;
    });
    this.token = await this.pendingToken;
    return this.token;
  }

  private async refreshAccessToken(): Promise<CachedToken> {
    const config = this.oauth.config();
    const row = await this.connections.get();
    if (!row?.refresh_token_enc) {
      throw new GoogleNotConnectedError();
    }
    const now = () => new Date(this.runtime.now()).toISOString();
    let refreshToken: string;
    try {
      refreshToken = decryptToken(row.refresh_token_enc, config.encKey);
    } catch (err) {
      await this.recordRefreshFailure(err as Error, now());
      throw err;
    }
    let grant: Awaited<ReturnType<GoogleOAuthClient['refresh']>>;
    try {
      grant = await this.oauth.refresh(refreshToken);
    } catch (err) {
      await this.recordRefreshFailure(err as Error, now());
      throw err;
    }
    await this.connections.recordRefresh(now());
    const lifetimeMs = grant.expiresInSeconds * 1000;
    return {
      value: grant.accessToken,
      refreshAt:
        this.runtime.now() +
        Math.max(lifetimeMs - ACCESS_TOKEN_REFRESH_MARGIN_MS, 0),
    };
  }

  private async recordRefreshFailure(err: Error, at: string): Promise<void> {
    const invalidGrant =
      err instanceof GoogleAuthError && err.code === INVALID_GRANT;
    const message = (
      err instanceof GoogleAuthError
        ? err.code
        : err instanceof TokenDecryptError
          ? 'token_decrypt_failed'
          : 'token_refresh_failed'
    ).slice(0, 200);
    try {
      await this.connections.recordError(message, at, {
        clearToken: invalidGrant,
      });
    } catch (recordErr) {
      this.logger.error(
        `Failed to record Google refresh error: ${(recordErr as Error).message}`,
      );
    }
    if (invalidGrant) {
      this.logger.warn('Google refresh token rejected; marked disconnected');
      void this.audit?.record({
        action: AUDIT_ACTIONS.googleTokenInvalid,
        actor: { userId: null, role: 'system' },
        targetType: 'google_connection',
        metadata: { reason: INVALID_GRANT },
      });
      throw new GoogleNotConnectedError();
    }
  }
}

function eventsPath(calendarId: string): string {
  return `/calendars/${encodeURIComponent(calendarId)}/events`;
}

function newEventId(): string {
  const bytes = randomBytes(20);
  return Array.from(bytes, (b) => EVENT_ID_ALPHABET[b % 32]).join('');
}

function toEventBody(event: GoogleEventInput): Record<string, unknown> {
  const { ssmsClassId, ...rest } = event;
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined) {
      body[key] = value;
    }
  }
  if (ssmsClassId !== undefined) {
    body.extendedProperties = { private: { ssmsClassId } };
  }
  return body;
}

function toEvent(resource: EventResource): GoogleEvent {
  return {
    id: resource.id,
    status: resource.status ?? null,
    htmlLink: resource.htmlLink ?? null,
    summary: resource.summary ?? null,
    start: resource.start ?? null,
    end: resource.end ?? null,
    ssmsClassId: resource.extendedProperties?.private?.ssmsClassId ?? null,
  };
}
