import { validateSignEnv } from './sign-env.validation';

const base = {
  SUPABASE_URL: 'http://localhost',
  SUPABASE_SECRET_KEY: 'secret',
};

const production = {
  ...base,
  NODE_ENV: 'production',
  CORS_ALLOWED_ORIGINS: 'https://sign.ssnow.club',
  R2_ACCOUNT_ID: 'account',
  R2_PRIVATE_BUCKET: 'ssms-private',
  R2_ACCESS_KEY_ID: 'key',
  R2_SECRET_ACCESS_KEY: 'secret',
  RESEND_API_KEY: 're_test',
  MAIL_FROM: 'Serendipity Snow <noreply@contact.ssnow.club>',
};

describe('validateSignEnv', () => {
  it('needs only Supabase outside production', () => {
    expect(validateSignEnv(base)).toBe(base);
    expect(() => validateSignEnv({ SUPABASE_URL: 'x' })).toThrow(
      'Missing required environment variables: SUPABASE_SECRET_KEY.',
    );
  });

  it('does not need the portal-only storage bucket or internal token', () => {
    expect(validateSignEnv(production)).toBe(production);
  });

  it('requires CORS, R2 and Resend settings in production', () => {
    expect(() => validateSignEnv({ ...base, NODE_ENV: 'production' })).toThrow(
      'Missing required environment variables: CORS_ALLOWED_ORIGINS, R2_ACCOUNT_ID, R2_PRIVATE_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, RESEND_API_KEY, MAIL_FROM.',
    );
    expect(() =>
      validateSignEnv({ ...production, CORS_ALLOWED_ORIGINS: ' ' }),
    ).toThrow('CORS_ALLOWED_ORIGINS');
  });

  it.each([
    '*',
    'https://*.ssnow.club',
    'sign.ssnow.club',
    'https://sign.ssnow.club/',
  ])('refuses %s as a CORS origin', (origin) => {
    expect(() =>
      validateSignEnv({
        ...production,
        CORS_ALLOWED_ORIGINS: `https://sign.ssnow.club,${origin}`,
      }),
    ).toThrow(`CORS_ALLOWED_ORIGINS must list exact origins, got: ${origin}`);
  });
});
