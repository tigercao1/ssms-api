import {
  DEFAULT_GOOGLE_ALLOWED_ACCOUNT,
  DEFAULT_GOOGLE_OAUTH_REDIRECT_URI,
  DEFAULT_GOOGLE_OAUTH_RETURN_URL,
  readGoogleConfig,
} from './google.config';
import { GoogleNotConfiguredError } from './google.errors';

const key = Buffer.alloc(32, 1).toString('base64');
const env = (values: Record<string, string>) => (k: string) => values[k];

describe('readGoogleConfig', () => {
  it('applies the documented defaults', () => {
    const config = readGoogleConfig(
      env({
        GOOGLE_CLIENT_ID: 'id',
        GOOGLE_CLIENT_SECRET: 'secret',
        GOOGLE_TOKEN_ENC_KEY: key,
      }),
    );
    expect(config).toMatchObject({
      clientId: 'id',
      clientSecret: 'secret',
      redirectUri: DEFAULT_GOOGLE_OAUTH_REDIRECT_URI,
      allowedAccount: DEFAULT_GOOGLE_ALLOWED_ACCOUNT,
      hostedDomain: 'ssnow.club',
      returnUrl: DEFAULT_GOOGLE_OAUTH_RETURN_URL,
    });
    expect(config.encKey).toHaveLength(32);
    expect(DEFAULT_GOOGLE_OAUTH_REDIRECT_URI).toBe(
      'https://ssms-api-vivid-brook-6788.fly.dev/admin/google/oauth/callback',
    );
  });

  it('honours overrides and lower-cases the allowed account', () => {
    const config = readGoogleConfig(
      env({
        GOOGLE_CLIENT_ID: 'id',
        GOOGLE_CLIENT_SECRET: 'secret',
        GOOGLE_TOKEN_ENC_KEY: key,
        GOOGLE_OAUTH_REDIRECT_URI: 'http://localhost:3000/cb',
        GOOGLE_ALLOWED_ACCOUNT: 'Ops@Example.com',
        GOOGLE_OAUTH_RETURN_URL: 'http://localhost:5173/g',
      }),
    );
    expect(config).toMatchObject({
      redirectUri: 'http://localhost:3000/cb',
      allowedAccount: 'ops@example.com',
      hostedDomain: 'example.com',
      returnUrl: 'http://localhost:5173/g',
    });
  });

  it('lists every missing secret', () => {
    expect(() => readGoogleConfig(env({}))).toThrow(
      new GoogleNotConfiguredError([
        'GOOGLE_CLIENT_ID',
        'GOOGLE_CLIENT_SECRET',
        'GOOGLE_TOKEN_ENC_KEY',
      ]),
    );
  });

  it.each([
    Buffer.alloc(16, 1).toString('base64'),
    'not base64!',
    Buffer.alloc(33, 1).toString('base64'),
  ])('treats a key that is not 32 base64 bytes as missing (%p)', (bad) => {
    expect(() =>
      readGoogleConfig(
        env({
          GOOGLE_CLIENT_ID: 'id',
          GOOGLE_CLIENT_SECRET: 'secret',
          GOOGLE_TOKEN_ENC_KEY: bad,
        }),
      ),
    ).toThrow('missing GOOGLE_TOKEN_ENC_KEY');
  });
});
