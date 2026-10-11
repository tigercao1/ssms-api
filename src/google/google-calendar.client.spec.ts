import {
  configFrom,
  fakeGoogleRuntime,
  GOOGLE_ENV,
  InMemoryGoogleConnectionRepository,
  json,
  type RecordedCall,
  recordingAudit,
  TEST_ENC_KEY,
} from '../../test/helpers/google-fakes';
import type { AuditService } from '../audit/audit.service';
import { AUDIT_ACTIONS } from '../audit/audit.types';
import {
  GoogleApiError,
  GoogleAuthError,
  GoogleNotConfiguredError,
  GoogleNotConnectedError,
} from './google.errors';
import {
  GOOGLE_CALENDAR_API,
  GoogleCalendarClient,
} from './google-calendar.client';
import { GOOGLE_TOKEN_URL, GoogleOAuthClient } from './google-oauth.client';
import { encryptToken, TokenDecryptError } from './token-cipher';

const KEY = Buffer.from(TEST_ENC_KEY, 'base64');
const REFRESH_TOKEN = '1//refresh-secret';
const FROM = '2026-10-12T00:00:00.000Z';
const TO = '2026-10-19T00:00:00.000Z';

type ApiHandler = (call: RecordedCall) => Response | Promise<Response>;

function build(
  api: ApiHandler = () => json({}),
  options: {
    token?: (call: RecordedCall) => Response;
    env?: Record<string, string>;
    connected?: boolean;
  } = {},
) {
  const repo = new InMemoryGoogleConnectionRepository();
  if (options.connected !== false) {
    repo.row = {
      account_email: 'admin@ssnow.club',
      refresh_token_enc: encryptToken(REFRESH_TOKEN, KEY),
      scopes: [],
      connected_at: '2026-10-01T00:00:00.000Z',
      connected_by: null,
      last_refresh_at: null,
      last_error: null,
      last_error_at: null,
    };
  }
  let tokenCount = 0;
  const fake = fakeGoogleRuntime((call) => {
    if (call.url === GOOGLE_TOKEN_URL) {
      tokenCount++;
      return options.token
        ? options.token(call)
        : json({ access_token: `at-${tokenCount}`, expires_in: 3600 });
    }
    return api(call);
  });
  const audit = recordingAudit();
  const oauth = new GoogleOAuthClient(
    configFrom(options.env ?? GOOGLE_ENV),
    fake.runtime,
  );
  const client = new GoogleCalendarClient(
    oauth,
    repo,
    fake.runtime,
    audit as unknown as AuditService,
  );
  const apiCalls = () =>
    fake.calls.filter((c) => c.url.startsWith(GOOGLE_CALENDAR_API));
  const tokenCalls = () => fake.calls.filter((c) => c.url === GOOGLE_TOKEN_URL);
  return { ...fake, repo, audit, client, apiCalls, tokenCalls };
}

function freeBusyResponder(call: RecordedCall): Response {
  const body = JSON.parse(call.body as string) as { items: { id: string }[] };
  return json({
    calendars: Object.fromEntries(
      body.items.map(({ id }) => [
        id,
        id === 'cal-7@group.calendar.google.com'
          ? { busy: [], errors: [{ domain: 'global', reason: 'notFound' }] }
          : { busy: [{ start: FROM, end: '2026-10-12T01:00:00.000Z' }] },
      ]),
    ),
  });
}

const ids = (n: number) =>
  Array.from({ length: n }, (_, i) => `cal-${i}@group.calendar.google.com`);

describe('GoogleCalendarClient', () => {
  describe('connection state', () => {
    it('is not connected without Google env and makes no calls', async () => {
      const { client, runtime } = build(undefined, { env: {} });
      await expect(client.isConnected()).resolves.toBe(false);
      await expect(client.listCalendars()).rejects.toThrow(
        GoogleNotConfiguredError,
      );
      expect(runtime.fetch).not.toHaveBeenCalled();
    });

    it('is not connected without a stored refresh token', async () => {
      const { client, runtime } = build(undefined, { connected: false });
      await expect(client.isConnected()).resolves.toBe(false);
      await expect(client.listCalendars()).rejects.toThrow(
        GoogleNotConnectedError,
      );
      expect(runtime.fetch).not.toHaveBeenCalled();
    });

    it('is connected with a stored token', async () => {
      await expect(build().client.isConnected()).resolves.toBe(true);
    });
  });

  describe('access token', () => {
    it('refreshes from the decrypted stored token, caches it and records the refresh', async () => {
      const ctx = build(() => json({ items: [] }));
      ctx.repo.row!.last_error = 'old';
      await ctx.client.listCalendars();
      await ctx.client.listCalendars();
      expect(ctx.tokenCalls()).toHaveLength(1);
      const form = new URLSearchParams(ctx.tokenCalls()[0].body);
      expect(form.get('refresh_token')).toBe(REFRESH_TOKEN);
      expect(ctx.apiCalls()[1].headers.Authorization).toBe('Bearer at-1');
      expect(ctx.repo.row).toMatchObject({
        last_refresh_at: '2026-10-11T12:00:00.000Z',
        last_error: null,
      });
    });

    it('shares one refresh between concurrent calls', async () => {
      const ctx = build(() => json({ items: [] }));
      await Promise.all([
        ctx.client.listCalendars(),
        ctx.client.listCalendars(),
      ]);
      expect(ctx.tokenCalls()).toHaveLength(1);
    });

    it('refreshes again shortly before expiry', async () => {
      const ctx = build(() => json({ items: [] }));
      await ctx.client.listCalendars();
      ctx.advance(3600_000 - 59_000);
      await ctx.client.listCalendars();
      expect(ctx.tokenCalls()).toHaveLength(2);
      expect(ctx.apiCalls()[1].headers.Authorization).toBe('Bearer at-2');
    });

    it('refreshes once and retries when Google answers 401', async () => {
      let n = 0;
      const ctx = build(() =>
        ++n === 1 ? json({ error: { code: 401 } }, 401) : json({ items: [] }),
      );
      await expect(ctx.client.listCalendars()).resolves.toEqual([]);
      expect(ctx.tokenCalls()).toHaveLength(2);
      expect(ctx.apiCalls()[1].headers.Authorization).toBe('Bearer at-2');
    });

    it('drops the cached token on invalidate()', async () => {
      const ctx = build(() => json({ items: [] }));
      await ctx.client.listCalendars();
      ctx.client.invalidate();
      await ctx.client.listCalendars();
      expect(ctx.tokenCalls()).toHaveLength(2);
    });

    it('marks the connection disconnected on invalid_grant', async () => {
      const ctx = build(undefined, {
        token: () =>
          json(
            {
              error: 'invalid_grant',
              error_description: 'Token has been expired or revoked.',
            },
            400,
          ),
      });
      await expect(ctx.client.listCalendars()).rejects.toThrow(
        GoogleNotConnectedError,
      );
      expect(ctx.repo.row).toMatchObject({
        refresh_token_enc: null,
        last_error: 'invalid_grant',
        last_error_at: '2026-10-11T12:00:00.000Z',
      });
      await expect(ctx.client.isConnected()).resolves.toBe(false);
      expect(ctx.audit.entries).toEqual([
        expect.objectContaining({
          action: AUDIT_ACTIONS.googleTokenInvalid,
          targetType: 'google_connection',
        }),
      ]);
      expect(JSON.stringify(ctx.audit.entries)).not.toContain(REFRESH_TOKEN);
      expect(ctx.apiCalls()).toHaveLength(0);
    });

    it('records other refresh failures but keeps the token', async () => {
      const ctx = build(undefined, {
        token: () => json({ error: 'invalid_client' }, 401),
      });
      await expect(ctx.client.listCalendars()).rejects.toThrow(GoogleAuthError);
      expect(ctx.repo.row?.refresh_token_enc).not.toBeNull();
      expect(ctx.repo.row?.last_error).toBe('invalid_client');
      expect(ctx.audit.entries).toHaveLength(0);
    });

    it('records an undecryptable stored token', async () => {
      const ctx = build();
      ctx.repo.row!.refresh_token_enc = encryptToken('x', Buffer.alloc(32, 9));
      await expect(ctx.client.listCalendars()).rejects.toThrow(
        TokenDecryptError,
      );
      expect(ctx.repo.row?.last_error).toBe('token_decrypt_failed');
      expect(ctx.tokenCalls()).toHaveLength(0);
    });

    it('still throws when recording the error fails', async () => {
      const ctx = build(undefined, {
        token: () => json({ error: 'invalid_grant' }, 400),
      });
      jest
        .spyOn(ctx.repo, 'recordError')
        .mockRejectedValue(new Error('db down'));
      await expect(ctx.client.listCalendars()).rejects.toThrow(
        GoogleNotConnectedError,
      );
    });
  });

  describe('listCalendars', () => {
    it('follows pagination and returns id, summary and accessRole', async () => {
      const ctx = build((call) =>
        new URL(call.url).searchParams.get('pageToken') === 'p2'
          ? json({
              items: [{ id: 'b@x', summary: 'B', accessRole: 'reader' }],
            })
          : json({
              items: [
                {
                  id: 'a@x',
                  summary: 'A',
                  summaryOverride: 'Alice',
                  accessRole: 'owner',
                },
                { id: 'c@x', accessRole: 'freeBusyReader' },
              ],
              nextPageToken: 'p2',
            }),
      );
      await expect(ctx.client.listCalendars()).resolves.toEqual([
        { id: 'a@x', summary: 'Alice', accessRole: 'owner' },
        { id: 'c@x', summary: 'c@x', accessRole: 'freeBusyReader' },
        { id: 'b@x', summary: 'B', accessRole: 'reader' },
      ]);
      const urls = ctx.apiCalls().map((c) => new URL(c.url));
      expect(urls.map((u) => u.pathname)).toEqual([
        '/calendar/v3/users/me/calendarList',
        '/calendar/v3/users/me/calendarList',
      ]);
      expect(urls[0].searchParams.get('maxResults')).toBe('250');
    });
  });

  describe('freeBusy', () => {
    it('splits 120 calendars into 3 requests of at most 50 and merges them', async () => {
      const ctx = build(freeBusyResponder);
      const calendarIds = ids(120);
      const result = await ctx.client.freeBusy(calendarIds, FROM, TO);
      const calls = ctx.apiCalls();
      expect(calls).toHaveLength(3);
      const batches = calls.map(
        (c) =>
          JSON.parse(c.body as string) as {
            timeMin: string;
            timeMax: string;
            items: { id: string }[];
          },
      );
      expect(batches.map((b) => b.items.length)).toEqual([50, 50, 20]);
      expect(batches.every((b) => b.timeMin === FROM && b.timeMax === TO)).toBe(
        true,
      );
      expect(batches.flatMap((b) => b.items.map((i) => i.id))).toEqual(
        calendarIds,
      );
      expect(result.calendars.map((c) => c.id)).toEqual(calendarIds);
      expect(result.calendars[0]).toEqual({
        id: calendarIds[0],
        busy: [{ start: FROM, end: '2026-10-12T01:00:00.000Z' }],
        errors: [],
      });
      expect(result.calendars[7].errors).toEqual([
        { domain: 'global', reason: 'notFound' },
      ]);
    });

    it('dedupes ids and flags calendars missing from the response', async () => {
      const ctx = build(() => json({ calendars: {} }));
      const result = await ctx.client.freeBusy(['a', 'a', 'b'], FROM, TO);
      expect(ctx.apiCalls()).toHaveLength(1);
      expect(result.calendars).toEqual([
        {
          id: 'a',
          busy: [],
          errors: [{ domain: 'ssms', reason: 'missingFromResponse' }],
        },
        {
          id: 'b',
          busy: [],
          errors: [{ domain: 'ssms', reason: 'missingFromResponse' }],
        },
      ]);
    });

    it('makes no call for an empty list', async () => {
      const ctx = build();
      await expect(ctx.client.freeBusy([], FROM, TO)).resolves.toEqual({
        timeMin: FROM,
        timeMax: TO,
        calendars: [],
      });
      expect(ctx.runtime.fetch).not.toHaveBeenCalled();
    });
  });

  describe('retry', () => {
    it('retries 429 and 5xx with backoff, honouring Retry-After', async () => {
      const responses = [
        json({}, 429, { 'Retry-After': '2' }),
        json({}, 503),
        json({ items: [] }),
      ];
      const ctx = build(() => responses.shift() as Response);
      await expect(ctx.client.listCalendars()).resolves.toEqual([]);
      expect(ctx.apiCalls()).toHaveLength(3);
      expect(ctx.sleeps).toEqual([2000, 1000]);
    });

    it('retries a 403 rate-limit but not a plain 403', async () => {
      const rateLimited = () =>
        json(
          {
            error: { code: 403, errors: [{ reason: 'userRateLimitExceeded' }] },
          },
          403,
        );
      const responses = [rateLimited(), json({ items: [] })];
      const ctx = build(() => responses.shift() as Response);
      await expect(ctx.client.listCalendars()).resolves.toEqual([]);
      expect(ctx.apiCalls()).toHaveLength(2);

      const denied = build(() =>
        json(
          {
            error: {
              code: 403,
              message: 'Forbidden',
              errors: [{ reason: 'forbidden' }],
            },
          },
          403,
        ),
      );
      const err = (await denied.client
        .listCalendars()
        .catch((e: unknown) => e)) as GoogleApiError;
      expect(err).toBeInstanceOf(GoogleApiError);
      expect(err).toMatchObject({ status: 403, reason: 'forbidden' });
      expect(denied.apiCalls()).toHaveLength(1);
    });

    it('gives up after 4 attempts', async () => {
      const ctx = build(() =>
        json({ error: { code: 500, message: 'boom' } }, 500),
      );
      await expect(ctx.client.listCalendars()).rejects.toMatchObject({
        status: 500,
      });
      expect(ctx.apiCalls()).toHaveLength(4);
      expect(ctx.sleeps).toEqual([500, 1000, 2000]);
    });

    it('caps backoff and maps network failures', async () => {
      const ctx = build(() =>
        json({ items: [] }, 503, { 'Retry-After': '120' }),
      );
      await ctx.client.listCalendars().catch(() => undefined);
      expect(ctx.sleeps).toEqual([8000, 8000, 8000]);

      const offline = build(() => {
        throw new Error('ECONNREFUSED');
      });
      await expect(offline.client.listCalendars()).rejects.toMatchObject({
        status: undefined,
        detail: 'ECONNREFUSED',
      });
      expect(offline.apiCalls()).toHaveLength(4);
    });
  });

  describe('events', () => {
    const start = {
      dateTime: '2026-10-12T10:00:00-04:00',
      timeZone: 'America/Toronto',
    };
    const end = {
      dateTime: '2026-10-12T12:00:00-04:00',
      timeZone: 'America/Toronto',
    };

    function echo(call: RecordedCall): Response {
      const body = call.body
        ? (JSON.parse(call.body) as Record<string, unknown>)
        : {};
      return json({
        id:
          (body.id as string) ??
          decodeURIComponent(call.url.split('/').pop() as string),
        status: 'confirmed',
        htmlLink: 'https://calendar.google.com/event?eid=x',
        ...body,
      });
    }

    it('inserts an event tagged with the SSMS class id', async () => {
      const ctx = build(echo);
      const event = await ctx.client.insertEvent('inst@ssnow.club', {
        summary: 'Private lesson',
        start,
        end,
        description: undefined,
        ssmsClassId: 'class-1',
      });
      const call = ctx.apiCalls()[0];
      expect(call.method).toBe('POST');
      expect(call.url).toBe(
        `${GOOGLE_CALENDAR_API}/calendars/inst%40ssnow.club/events`,
      );
      const body = JSON.parse(call.body as string) as Record<string, unknown>;
      expect(body).toEqual({
        id: expect.stringMatching(/^[0-9a-v]{20}$/) as unknown,
        summary: 'Private lesson',
        start,
        end,
        extendedProperties: { private: { ssmsClassId: 'class-1' } },
      });
      expect(event).toEqual({
        id: body.id,
        status: 'confirmed',
        htmlLink: 'https://calendar.google.com/event?eid=x',
        summary: 'Private lesson',
        start,
        end,
        ssmsClassId: 'class-1',
      });
    });

    it('omits extendedProperties when no class id is given', async () => {
      const ctx = build(echo);
      const event = await ctx.client.insertEvent('c', {
        summary: 'x',
        start,
        end,
      });
      expect(JSON.parse(ctx.apiCalls()[0].body as string)).not.toHaveProperty(
        'extendedProperties',
      );
      expect(event.ssmsClassId).toBeNull();
    });

    it('returns the existing event when a retried insert reports a duplicate', async () => {
      const responses: ((c: RecordedCall) => Response)[] = [
        () => json({}, 503),
        () =>
          json(
            { error: { code: 409, errors: [{ reason: 'duplicate' }] } },
            409,
          ),
        (c) =>
          json({
            id: c.url.split('/').pop(),
            status: 'confirmed',
            summary: 'x',
          }),
      ];
      const ctx = build((c) =>
        (responses.shift() as (c: RecordedCall) => Response)(c),
      );
      const event = await ctx.client.insertEvent('c', {
        summary: 'x',
        start,
        end,
      });
      const calls = ctx.apiCalls();
      expect(calls.map((c) => c.method)).toEqual(['POST', 'POST', 'GET']);
      const sentId = (JSON.parse(calls[0].body as string) as { id: string }).id;
      expect(calls[2].url).toBe(
        `${GOOGLE_CALENDAR_API}/calendars/c/events/${sentId}`,
      );
      expect(event).toMatchObject({ id: sentId, summary: 'x' });
    });

    it('treats a first-attempt duplicate as an error', async () => {
      const ctx = build(() => json({}, 409));
      await expect(
        ctx.client.insertEvent('c', { summary: 'x', start, end }),
      ).rejects.toMatchObject({ status: 409, reason: 'duplicate' });
    });

    it('patches an event and keeps the class id tag', async () => {
      const ctx = build(echo);
      const event = await ctx.client.patchEvent('c@x', 'ev/1', {
        summary: 'Moved',
        ssmsClassId: 'class-2',
      });
      const call = ctx.apiCalls()[0];
      expect(call.method).toBe('PATCH');
      expect(call.url).toBe(
        `${GOOGLE_CALENDAR_API}/calendars/c%40x/events/ev%2F1`,
      );
      expect(JSON.parse(call.body as string)).toEqual({
        summary: 'Moved',
        extendedProperties: { private: { ssmsClassId: 'class-2' } },
      });
      expect(event).toMatchObject({ summary: 'Moved', ssmsClassId: 'class-2' });
    });

    it('deletes an event and tolerates one that is already gone', async () => {
      const statuses = [204, 404, 410];
      const ctx = build(() => new Response(null, { status: statuses.shift() }));
      await ctx.client.deleteEvent('c', 'e1');
      await ctx.client.deleteEvent('c', 'e2');
      await ctx.client.deleteEvent('c', 'e3');
      expect(ctx.apiCalls().map((c) => c.method)).toEqual([
        'DELETE',
        'DELETE',
        'DELETE',
      ]);
      const failing = build(() => json({ error: { code: 403 } }, 403));
      await expect(failing.client.deleteEvent('c', 'e')).rejects.toBeInstanceOf(
        GoogleApiError,
      );
    });

    it('accepts an empty success body', async () => {
      const ctx = build(() => new Response('', { status: 200 }));
      await expect(ctx.client.listCalendars()).resolves.toEqual([]);
    });
  });
});
