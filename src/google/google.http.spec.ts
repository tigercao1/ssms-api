import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  Logger,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  configFrom,
  fakeGoogleRuntime,
  GOOGLE_ENV,
  idToken,
  InMemoryGoogleConnectionRepository,
  json,
  type RecordedCall,
  recordingAudit,
  TEST_CLIENT_ID,
  TEST_ENC_KEY,
} from '../../test/helpers/google-fakes';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ACTIONS } from '../audit/audit.types';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { GOOGLE_CALENDAR_SCOPES } from './google.config';
import {
  GoogleAdminController,
  GoogleOAuthCallbackController,
} from './google.controller';
import type { GoogleConnectionStatus } from './google.types';
import {
  GOOGLE_CALENDAR_API,
  GoogleCalendarClient,
} from './google-calendar.client';
import { GoogleConnectionRepository } from './google-connection.repository';
import {
  GOOGLE_CALLBACK_ERRORS,
  GoogleConnectionService,
} from './google-connection.service';
import {
  GOOGLE_NOT_CONFIGURED,
  GOOGLE_NOT_CONNECTED,
  GOOGLE_UNAVAILABLE,
} from './google-error.filter';
import {
  GOOGLE_REVOKE_URL,
  GOOGLE_TOKEN_URL,
  GOOGLE_USERINFO_URL,
  GoogleOAuthClient,
} from './google-oauth.client';
import { GOOGLE_RUNTIME } from './google-runtime';
import { OAUTH_STATE_TTL_MS, signOAuthState } from './oauth-state';
import { decryptToken, encryptToken } from './token-cipher';

const ADMIN_ID = '7d0f8a1e-5b2c-4e3d-9a8b-1c2d3e4f5a6b';
const KEY = Buffer.from(TEST_ENC_KEY, 'base64');
const PORTAL = 'https://app.ssnow.club/admin/settings/google';
const REFRESH_TOKEN = '1//granted-refresh-token';

class FakeJwtGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const role = /^Bearer jwt-(\w+)$/.exec(
      req.headers.authorization ?? '',
    )?.[1];
    if (!role) {
      throw new UnauthorizedException();
    }
    (req as Request & { user: unknown }).user = {
      sub: role === 'admin' ? ADMIN_ID : 'user-1',
      app_metadata: { role },
    };
    return true;
  }
}

interface TokenGrant {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  id_token?: string;
}

const ALLOWED_USERINFO = { email: 'admin@ssnow.club', email_verified: true };

const goodGrant = (overrides: Partial<TokenGrant> = {}): TokenGrant => ({
  access_token: 'at-1',
  expires_in: 3599,
  refresh_token: REFRESH_TOKEN,
  scope: [
    'openid',
    'https://www.googleapis.com/auth/userinfo.email',
    ...GOOGLE_CALENDAR_SCOPES,
  ].join(' '),
  ...overrides,
});

async function build(env: Record<string, string> = GOOGLE_ENV) {
  const repo = new InMemoryGoogleConnectionRepository();
  const audit = recordingAudit();
  const state = {
    tokenResponse: (): Response => json(goodGrant()),
    userInfo: (): Response => json(ALLOWED_USERINFO),
    api: (call: RecordedCall): Response => json({ items: [], call: call.url }),
  };
  const fake = fakeGoogleRuntime((call) => {
    if (call.url === GOOGLE_TOKEN_URL) {
      return state.tokenResponse();
    }
    if (call.url === GOOGLE_USERINFO_URL) {
      return state.userInfo();
    }
    if (call.url === GOOGLE_REVOKE_URL) {
      return json({});
    }
    return state.api(call);
  });
  const moduleRef = await Test.createTestingModule({
    controllers: [GoogleAdminController, GoogleOAuthCallbackController],
    providers: [
      GoogleConnectionService,
      GoogleOAuthClient,
      GoogleCalendarClient,
      { provide: ConfigService, useValue: configFrom(env) },
      { provide: GoogleConnectionRepository, useValue: repo },
      { provide: GOOGLE_RUNTIME, useValue: fake.runtime },
      { provide: AuditService, useValue: audit },
    ],
  })
    .overrideGuard(SupabaseAuthGuard)
    .useClass(FakeJwtGuard)
    .compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await app.listen(0, '127.0.0.1');
  return { app, repo, audit, state, ...fake };
}

function connectedRow() {
  return {
    account_email: 'admin@ssnow.club',
    refresh_token_enc: encryptToken(REFRESH_TOKEN, KEY),
    scopes: [...GOOGLE_CALENDAR_SCOPES],
    connected_at: '2026-10-01T00:00:00.000Z',
    connected_by: ADMIN_ID,
    last_refresh_at: null,
    last_error: null,
    last_error_at: null,
  };
}

describe('/admin/google', () => {
  let ctx: Awaited<ReturnType<typeof build>>;
  const admin = 'Bearer jwt-admin';
  const http = () => request(ctx.app.getHttpServer());

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  beforeEach(async () => {
    ctx = await build();
  });

  afterEach(async () => {
    await ctx.app.close();
  });

  async function connectState(): Promise<string> {
    const res = await http()
      .get('/admin/google/connect')
      .set('Authorization', admin)
      .expect(200);
    return new URL((res.body as { url: string }).url).searchParams.get(
      'state',
    ) as string;
  }

  function callback(query: Record<string, string>) {
    return http().get('/admin/google/oauth/callback').query(query);
  }

  function redirectOf(res: request.Response): URL {
    expect(res.status).toBe(302);
    return new URL(res.headers.location);
  }

  describe('auth', () => {
    const routes: [string, (r: ReturnType<typeof http>) => request.Test][] = [
      ['connect', (r) => r.get('/admin/google/connect')],
      ['status', (r) => r.get('/admin/google/status')],
      ['disconnect', (r) => r.post('/admin/google/disconnect')],
      ['calendars', (r) => r.get('/admin/google/calendars')],
      ['freebusy', (r) => r.get('/admin/google/freebusy')],
    ];

    it.each(routes)('%s requires a token', async (_name, call) => {
      await call(http()).expect(401);
    });

    it.each(routes)('%s requires the admin role', async (_name, call) => {
      await call(http())
        .set('Authorization', 'Bearer jwt-instructor')
        .expect(403);
    });

    it('leaves the OAuth callback public', async () => {
      const res = await callback({ state: 'bad', code: 'c' });
      expect(redirectOf(res).searchParams.get('error')).toBe('invalid_state');
    });
  });

  describe('GET /connect', () => {
    it('returns the Google authorize URL with a state bound to the admin', async () => {
      const res = await http()
        .get('/admin/google/connect')
        .set('Authorization', admin)
        .expect(200);
      const url = new URL((res.body as { url: string }).url);
      expect(url.host).toBe('accounts.google.com');
      expect(url.searchParams.get('access_type')).toBe('offline');
      expect(url.searchParams.get('prompt')).toBe('consent');
      expect(url.searchParams.get('hd')).toBe('ssnow.club');
      expect(url.searchParams.get('state')).toMatch(/^[\w-]+\.[\w-]+$/);
      expect(ctx.runtime.fetch).not.toHaveBeenCalled();
    });
  });

  describe('GET /oauth/callback', () => {
    it('exposes exactly the documented callback error codes', () => {
      expect(Object.values(GOOGLE_CALLBACK_ERRORS).sort()).toEqual(
        [
          'access_denied',
          'wrong_account',
          'missing_scopes',
          'invalid_state',
          'token_exchange_failed',
          'no_refresh_token',
          'not_configured',
          'oauth_error',
          'missing_code',
          'server_error',
        ].sort(),
      );
    });

    it('stores the encrypted refresh token, audits and redirects to the portal', async () => {
      const state = await connectState();
      const res = await callback({ state, code: 'auth-code', scope: 'x' });
      const location = redirectOf(res);
      expect(`${location.origin}${location.pathname}`).toBe(PORTAL);
      expect(location.searchParams.get('connected')).toBe('1');

      const row = ctx.repo.row!;
      expect(row.account_email).toBe('admin@ssnow.club');
      expect(row.connected_by).toBe(ADMIN_ID);
      expect(row.scopes).toEqual(
        expect.arrayContaining([...GOOGLE_CALENDAR_SCOPES]),
      );
      expect(row.refresh_token_enc).not.toContain(REFRESH_TOKEN);
      expect(decryptToken(row.refresh_token_enc as string, KEY)).toBe(
        REFRESH_TOKEN,
      );

      expect(ctx.audit.entries).toEqual([
        expect.objectContaining({
          action: AUDIT_ACTIONS.googleConnect,
          actor: { userId: ADMIN_ID, role: 'admin' },
          targetType: 'google_connection',
        }),
      ]);
      expect(JSON.stringify(ctx.audit.entries)).not.toContain(REFRESH_TOKEN);
      expect(res.headers.location).not.toContain(REFRESH_TOKEN);

      const exchange = new URLSearchParams(ctx.calls[0].body);
      expect(exchange.get('code')).toBe('auth-code');
    });

    it('verifies the account through userinfo with the fresh access token', async () => {
      await callback({ state: await connectState(), code: 'c' });
      const lookup = ctx.calls.find((c) => c.url === GOOGLE_USERINFO_URL);
      expect(lookup?.headers).toMatchObject({ Authorization: 'Bearer at-1' });
    });

    it('accepts the allowed account regardless of email case', async () => {
      ctx.state.userInfo = () =>
        json({ email: 'Admin@SSnow.Club', email_verified: true });
      const res = await callback({ state: await connectState(), code: 'c' });
      expect(redirectOf(res).searchParams.get('connected')).toBe('1');
      expect(ctx.repo.row?.account_email).toBe('admin@ssnow.club');
    });

    it('rejects a different Google account and revokes what it was given', async () => {
      ctx.state.userInfo = () =>
        json({ email: 'someone@ssnow.club', email_verified: true });
      const res = await callback({ state: await connectState(), code: 'c' });
      expect(redirectOf(res).searchParams.get('error')).toBe('wrong_account');
      expect(ctx.repo.row).toBeNull();
      const revoke = ctx.calls.find((c) => c.url === GOOGLE_REVOKE_URL);
      expect(new URLSearchParams(revoke?.body).get('token')).toBe(
        REFRESH_TOKEN,
      );
      expect(ctx.audit.entries).toEqual([
        expect.objectContaining({
          action: AUDIT_ACTIONS.googleConnectRejected,
          metadata: expect.objectContaining({
            reason: 'wrong_account',
            accountEmail: 'someone@ssnow.club',
          }) as unknown,
        }),
      ]);
    });

    it('ignores an id_token that claims the allowed account', async () => {
      ctx.state.tokenResponse = () =>
        json(
          goodGrant({
            id_token: idToken({
              iss: 'https://accounts.google.com',
              aud: TEST_CLIENT_ID,
              email: 'admin@ssnow.club',
              email_verified: true,
            }),
          }),
        );
      ctx.state.userInfo = () =>
        json({ email: 'someone@ssnow.club', email_verified: true });
      const res = await callback({ state: await connectState(), code: 'c' });
      expect(redirectOf(res).searchParams.get('error')).toBe('wrong_account');
      expect(ctx.repo.row).toBeNull();
    });

    it.each([
      ['unverified', { email: 'admin@ssnow.club', email_verified: false }],
      ['missing', { email_verified: true }],
    ])('rejects a userinfo response with an %s email', async (_label, body) => {
      ctx.state.userInfo = () => json(body);
      const res = await callback({ state: await connectState(), code: 'c' });
      expect(redirectOf(res).searchParams.get('error')).toBe('wrong_account');
      expect(ctx.repo.row).toBeNull();
    });

    it.each([
      [
        'a network error',
        () => {
          throw new Error('ECONNRESET');
        },
      ],
      ['an HTTP error', () => json({ error: 'invalid_token' }, 401)],
    ])(
      'reports token_exchange_failed and revokes on %s from userinfo',
      async (_label, userInfo) => {
        ctx.state.userInfo = userInfo;
        const res = await callback({ state: await connectState(), code: 'c' });
        expect(redirectOf(res).searchParams.get('error')).toBe(
          'token_exchange_failed',
        );
        expect(ctx.repo.row).toBeNull();
        const revoke = ctx.calls.find((c) => c.url === GOOGLE_REVOKE_URL);
        expect(new URLSearchParams(revoke?.body).get('token')).toBe(
          REFRESH_TOKEN,
        );
      },
    );

    it.each(GOOGLE_CALENDAR_SCOPES.map((s) => [s]))(
      'rejects a grant missing %s',
      async (missing) => {
        ctx.state.tokenResponse = () =>
          json(
            goodGrant({
              scope: GOOGLE_CALENDAR_SCOPES.filter((s) => s !== missing).join(
                ' ',
              ),
            }),
          );
        const res = await callback({ state: await connectState(), code: 'c' });
        expect(redirectOf(res).searchParams.get('error')).toBe(
          'missing_scopes',
        );
        expect(ctx.repo.row).toBeNull();
        expect(ctx.audit.entries[0]).toMatchObject({
          action: AUDIT_ACTIONS.googleConnectRejected,
          metadata: { reason: 'missing_scopes' },
        });
      },
    );

    it('rejects a grant without a refresh token', async () => {
      ctx.state.tokenResponse = () =>
        json(goodGrant({ refresh_token: undefined }));
      const res = await callback({ state: await connectState(), code: 'c' });
      expect(redirectOf(res).searchParams.get('error')).toBe(
        'no_refresh_token',
      );
      const revoke = ctx.calls.find((c) => c.url === GOOGLE_REVOKE_URL);
      expect(new URLSearchParams(revoke?.body).get('token')).toBe('at-1');
    });

    it.each([
      [
        'a forged state',
        () => signOAuthState(ADMIN_ID, 'wrong-secret', Date.now()),
      ],
      ['a missing state', () => undefined],
    ])('rejects %s without calling Google', async (_label, makeState) => {
      const state = makeState();
      const res = await callback({ code: 'c', ...(state ? { state } : {}) });
      expect(redirectOf(res).searchParams.get('error')).toBe('invalid_state');
      expect(ctx.runtime.fetch).not.toHaveBeenCalled();
      expect(ctx.repo.row).toBeNull();
    });

    it('rejects an expired state', async () => {
      const state = await connectState();
      ctx.advance(OAUTH_STATE_TTL_MS);
      const res = await callback({ state, code: 'c' });
      expect(redirectOf(res).searchParams.get('error')).toBe('invalid_state');
      expect(ctx.runtime.fetch).not.toHaveBeenCalled();
    });

    it.each([
      ['access_denied', 'access_denied'],
      ['server_error', 'oauth_error'],
    ])('maps a Google %s to %s', async (googleError, code) => {
      const res = await callback({
        state: await connectState(),
        error: googleError,
      });
      expect(redirectOf(res).searchParams.get('error')).toBe(code);
      expect(ctx.runtime.fetch).not.toHaveBeenCalled();
    });

    it('requires a code', async () => {
      const res = await callback({ state: await connectState() });
      expect(redirectOf(res).searchParams.get('error')).toBe('missing_code');
    });

    it('reports a failed code exchange', async () => {
      ctx.state.tokenResponse = () => json({ error: 'invalid_grant' }, 400);
      const res = await callback({ state: await connectState(), code: 'c' });
      expect(redirectOf(res).searchParams.get('error')).toBe(
        'token_exchange_failed',
      );
    });

    it('revokes and reports a storage failure', async () => {
      ctx.repo.failSave = true;
      const res = await callback({ state: await connectState(), code: 'c' });
      expect(redirectOf(res).searchParams.get('error')).toBe('server_error');
      expect(ctx.calls.some((c) => c.url === GOOGLE_REVOKE_URL)).toBe(true);
    });
  });

  describe('GET /status', () => {
    it('reports a connection without exposing the token', async () => {
      ctx.repo.row = connectedRow();
      const res = await http()
        .get('/admin/google/status')
        .set('Authorization', admin)
        .expect(200);
      expect(res.body).toEqual({
        configured: true,
        connected: true,
        accountEmail: 'admin@ssnow.club',
        scopes: [...GOOGLE_CALENDAR_SCOPES],
        connectedAt: '2026-10-01T00:00:00.000Z',
        lastError: null,
      });
      expect(JSON.stringify(res.body)).not.toContain('v1:');
    });

    it('reports a connection lost to invalid_grant', async () => {
      ctx.repo.row = {
        ...connectedRow(),
        refresh_token_enc: null,
        last_error: 'invalid_grant',
      };
      const res = await http()
        .get('/admin/google/status')
        .set('Authorization', admin)
        .expect(200);
      expect(res.body).toMatchObject({
        connected: false,
        accountEmail: 'admin@ssnow.club',
        lastError: 'invalid_grant',
      });
    });
  });

  describe('POST /disconnect', () => {
    it('revokes at Google, deletes the row and audits', async () => {
      ctx.repo.row = connectedRow();
      const res = await http()
        .post('/admin/google/disconnect')
        .set('Authorization', admin)
        .set('User-Agent', 'jest')
        .expect(200);
      expect((res.body as GoogleConnectionStatus).connected).toBe(false);
      expect(ctx.repo.row).toBeNull();
      const revoke = ctx.calls.find((c) => c.url === GOOGLE_REVOKE_URL);
      expect(new URLSearchParams(revoke?.body).get('token')).toBe(
        REFRESH_TOKEN,
      );
      expect(ctx.audit.entries).toEqual([
        expect.objectContaining({
          action: AUDIT_ACTIONS.googleDisconnect,
          actor: { userId: ADMIN_ID, role: 'admin', userAgent: 'jest' },
          metadata: { accountEmail: 'admin@ssnow.club', revoked: true },
        }),
      ]);
    });

    it('still disconnects when the stored token cannot be decrypted', async () => {
      ctx.repo.row = { ...connectedRow(), refresh_token_enc: 'v1:x:y:z' };
      await http()
        .post('/admin/google/disconnect')
        .set('Authorization', admin)
        .expect(200);
      expect(ctx.repo.row).toBeNull();
      expect(ctx.audit.entries[0].metadata).toMatchObject({ revoked: false });
    });

    it('is a no-op when nothing is connected', async () => {
      await http()
        .post('/admin/google/disconnect')
        .set('Authorization', admin)
        .expect(200);
      expect(ctx.audit.entries).toHaveLength(0);
      expect(ctx.runtime.fetch).not.toHaveBeenCalled();
    });
  });

  describe('GET /calendars', () => {
    it('flags calendars SSMS cannot write to', async () => {
      ctx.repo.row = connectedRow();
      ctx.state.api = () =>
        json({
          items: [
            { id: 'a@x', summary: 'A', accessRole: 'owner' },
            { id: 'b@x', summary: 'B', accessRole: 'writer' },
            { id: 'c@x', summary: 'C', accessRole: 'reader' },
            { id: 'd@x', summary: 'D', accessRole: 'freeBusyReader' },
          ],
        });
      const res = await http()
        .get('/admin/google/calendars')
        .set('Authorization', admin)
        .expect(200);
      expect(res.body).toEqual([
        { id: 'a@x', summary: 'A', accessRole: 'owner', canWrite: true },
        { id: 'b@x', summary: 'B', accessRole: 'writer', canWrite: true },
        { id: 'c@x', summary: 'C', accessRole: 'reader', canWrite: false },
        {
          id: 'd@x',
          summary: 'D',
          accessRole: 'freeBusyReader',
          canWrite: false,
        },
      ]);
    });

    it('is 409 until connected', async () => {
      const res = await http()
        .get('/admin/google/calendars')
        .set('Authorization', admin)
        .expect(409);
      expect((res.body as { message: string }).message).toBe(
        GOOGLE_NOT_CONNECTED,
      );
      expect(ctx.runtime.fetch).not.toHaveBeenCalled();
    });

    it('is 502 when Google fails', async () => {
      ctx.repo.row = connectedRow();
      ctx.state.api = () =>
        json({ error: { code: 404, message: 'nope' } }, 404);
      const res = await http()
        .get('/admin/google/calendars')
        .set('Authorization', admin)
        .expect(502);
      expect((res.body as { message: string }).message).toBe(
        GOOGLE_UNAVAILABLE,
      );
    });

    it('is 503 when the stored token cannot be decrypted', async () => {
      ctx.repo.row = { ...connectedRow(), refresh_token_enc: 'v1:x:y:z' };
      await http()
        .get('/admin/google/calendars')
        .set('Authorization', admin)
        .expect(503);
    });
  });

  describe('GET /freebusy', () => {
    const from = '2026-10-12T00:00:00-04:00';
    const to = '2026-10-19T00:00:00-04:00';

    it('returns merged free/busy for comma-separated and repeated ids', async () => {
      ctx.repo.row = connectedRow();
      ctx.state.api = (call) => {
        const body = JSON.parse(call.body as string) as {
          items: { id: string }[];
        };
        return json({
          calendars: Object.fromEntries(
            body.items.map(({ id }) => [id, { busy: [] }]),
          ),
        });
      };
      const res = await http()
        .get(
          `/admin/google/freebusy?calendarIds=a@x,b@x&calendarIds=c@x&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        )
        .set('Authorization', admin)
        .expect(200);
      expect(res.body).toEqual({
        timeMin: '2026-10-12T04:00:00.000Z',
        timeMax: '2026-10-19T04:00:00.000Z',
        calendars: ['a@x', 'b@x', 'c@x'].map((id) => ({
          id,
          busy: [],
          errors: [],
        })),
      });
      const sent = ctx.calls.find(
        (c) => c.url === `${GOOGLE_CALENDAR_API}/freeBusy`,
      );
      expect(sent).toBeDefined();
    });

    it.each([
      ['no ids', { from, to }],
      ['an empty id list', { calendarIds: ',', from, to }],
      ['a bad date', { calendarIds: 'a', from: 'yesterday', to }],
      ['an unknown param', { calendarIds: 'a', from, to, extra: '1' }],
      ['to before from', { calendarIds: 'a', from: to, to: from }],
      [
        'a range over 31 days',
        { calendarIds: 'a', from, to: '2026-11-30T00:00:00Z' },
      ],
    ])('is 400 for %s', async (_label, query) => {
      ctx.repo.row = connectedRow();
      await http()
        .get('/admin/google/freebusy')
        .query(query)
        .set('Authorization', admin)
        .expect(400);
      expect(ctx.runtime.fetch).not.toHaveBeenCalled();
    });
  });
});

describe('/admin/google without Google env', () => {
  let ctx: Awaited<ReturnType<typeof build>>;
  const admin = 'Bearer jwt-admin';

  beforeEach(async () => {
    ctx = await build({});
  });

  afterEach(async () => {
    await ctx.app.close();
  });

  it('reports not configured and refuses to connect', async () => {
    const http = () => request(ctx.app.getHttpServer());
    const status = await http()
      .get('/admin/google/status')
      .set('Authorization', admin)
      .expect(200);
    expect(status.body).toEqual({
      configured: false,
      connected: false,
      accountEmail: null,
      scopes: [],
      connectedAt: null,
      lastError: null,
    });
    const connect = await http()
      .get('/admin/google/connect')
      .set('Authorization', admin)
      .expect(503);
    expect((connect.body as { message: string }).message).toBe(
      GOOGLE_NOT_CONFIGURED,
    );
    await http()
      .get('/admin/google/calendars')
      .set('Authorization', admin)
      .expect(503);
    const cb = await http()
      .get('/admin/google/oauth/callback?code=c&state=s')
      .expect(302);
    expect(cb.headers.location).toBe(`${PORTAL}?error=not_configured`);
    expect(ctx.runtime.fetch).not.toHaveBeenCalled();
  });
});
