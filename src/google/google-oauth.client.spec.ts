import {
  configFrom,
  fakeGoogleRuntime,
  type FakeHandler,
  GOOGLE_ENV,
  idToken,
  json,
  TEST_CLIENT_ID,
} from '../../test/helpers/google-fakes';
import { GOOGLE_CALENDAR_SCOPES } from './google.config';
import { GoogleAuthError, GoogleNotConfiguredError } from './google.errors';
import {
  GOOGLE_AUTHORIZE_URL,
  GOOGLE_REVOKE_URL,
  GOOGLE_TOKEN_URL,
  GoogleOAuthClient,
} from './google-oauth.client';

const goodClaims = {
  iss: 'https://accounts.google.com',
  aud: TEST_CLIENT_ID,
  email: 'Admin@ssnow.club',
  email_verified: true,
};

function build(handler: FakeHandler, env = GOOGLE_ENV) {
  const fake = fakeGoogleRuntime(handler);
  return {
    ...fake,
    client: new GoogleOAuthClient(configFrom(env), fake.runtime),
  };
}

describe('GoogleOAuthClient', () => {
  it('reports unconfigured without throwing', () => {
    const { client } = build(() => json({}), {});
    expect(client.isConfigured()).toBe(false);
    expect(() => client.authorizeUrl('s')).toThrow(GoogleNotConfiguredError);
  });

  it('builds an offline, consent, hosted-domain authorize URL', () => {
    const { client } = build(() => json({}));
    const url = new URL(client.authorizeUrl('state-1'));
    expect(`${url.origin}${url.pathname}`).toBe(GOOGLE_AUTHORIZE_URL);
    const p = url.searchParams;
    expect(p.get('client_id')).toBe(TEST_CLIENT_ID);
    expect(p.get('redirect_uri')).toBe(
      'https://ssms-api-vivid-brook-6788.fly.dev/admin/google/oauth/callback',
    );
    expect(p.get('response_type')).toBe('code');
    expect(p.get('access_type')).toBe('offline');
    expect(p.get('prompt')).toBe('consent');
    expect(p.get('include_granted_scopes')).toBe('true');
    expect(p.get('hd')).toBe('ssnow.club');
    expect(p.get('state')).toBe('state-1');
    expect(p.get('scope')?.split(' ')).toEqual(
      expect.arrayContaining([...GOOGLE_CALENDAR_SCOPES, 'openid', 'email']),
    );
  });

  it('exchanges a code and reads the verified email and granted scopes', async () => {
    const { client, calls } = build(() =>
      json({
        access_token: 'at',
        expires_in: 3599,
        refresh_token: 'rt',
        scope: GOOGLE_CALENDAR_SCOPES.join(' '),
        id_token: idToken(goodClaims),
      }),
    );
    await expect(client.exchangeCode('the-code')).resolves.toEqual({
      accessToken: 'at',
      expiresInSeconds: 3599,
      refreshToken: 'rt',
      scopes: [...GOOGLE_CALENDAR_SCOPES],
      email: 'admin@ssnow.club',
    });
    expect(calls[0].url).toBe(GOOGLE_TOKEN_URL);
    const form = new URLSearchParams(calls[0].body);
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('the-code');
    expect(form.get('redirect_uri')).toContain('/admin/google/oauth/callback');
  });

  it.each([
    ['wrong audience', { ...goodClaims, aud: 'someone-else' }],
    ['unverified email', { ...goodClaims, email_verified: false }],
    ['foreign issuer', { ...goodClaims, iss: 'https://evil.example' }],
    ['no email', { ...goodClaims, email: undefined }],
  ])('returns no email for an id_token with %s', async (_label, claims) => {
    const { client } = build(() =>
      json({ access_token: 'at', id_token: idToken(claims) }),
    );
    expect((await client.exchangeCode('c')).email).toBeNull();
  });

  it('returns no email when the id_token is missing or garbled', async () => {
    const { client } = build(() =>
      json({ access_token: 'at', id_token: 'a.%%%.c' }),
    );
    const grant = await client.exchangeCode('c');
    expect(grant).toMatchObject({
      email: null,
      refreshToken: null,
      scopes: [],
    });
    const { client: bare } = build(() => json({ access_token: 'at' }));
    expect((await bare.exchangeCode('c')).email).toBeNull();
  });

  it('surfaces the OAuth error code without echoing secrets', async () => {
    const { client } = build(() =>
      json({ error: 'invalid_grant', error_description: 'Bad Request' }, 400),
    );
    const err = (await client
      .refresh('rt-secret')
      .catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(GoogleAuthError);
    expect((err as GoogleAuthError).code).toBe('invalid_grant');
    expect(err.message).not.toContain('rt-secret');
    expect(err.message).not.toContain(GOOGLE_ENV.GOOGLE_CLIENT_SECRET);
  });

  it('rejects a token response without an access token', async () => {
    const { client } = build(() => json({}));
    await expect(client.refresh('rt')).rejects.toMatchObject({
      code: 'no_access_token',
    });
  });

  it('maps network failures to network_error after bounded retries', async () => {
    const { client, runtime, sleeps } = build(() => json({}));
    (runtime.fetch as jest.Mock).mockRejectedValue(new Error('ECONNRESET'));
    await expect(client.refresh('rt')).rejects.toMatchObject({
      code: 'network_error',
    });
    expect(runtime.fetch).toHaveBeenCalledTimes(4);
    expect(sleeps).toEqual([500, 1000, 2000]);
  });

  it('retries the token endpoint on 503', async () => {
    let n = 0;
    const { client, calls } = build(() =>
      ++n === 1 ? json({}, 503) : json({ access_token: 'at', expires_in: 60 }),
    );
    await expect(client.refresh('rt')).resolves.toEqual({
      accessToken: 'at',
      expiresInSeconds: 60,
    });
    expect(calls).toHaveLength(2);
    expect(new URLSearchParams(calls[1].body).get('grant_type')).toBe(
      'refresh_token',
    );
  });

  it('revokes a token and reports the outcome', async () => {
    const { client, calls } = build(() => json({}));
    await expect(client.revoke('tok')).resolves.toBe(true);
    expect(calls[0]).toMatchObject({ url: GOOGLE_REVOKE_URL, method: 'POST' });
    expect(new URLSearchParams(calls[0].body).get('token')).toBe('tok');

    const { client: failing } = build(() =>
      json({ error: 'invalid_token' }, 400),
    );
    await expect(failing.revoke('tok')).resolves.toBe(false);

    const { client: offline, runtime } = build(() => json({}));
    (runtime.fetch as jest.Mock).mockRejectedValue(new Error('down'));
    await expect(offline.revoke('tok')).resolves.toBe(false);
  });
});
