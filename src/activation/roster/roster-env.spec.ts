import { loadSsmsEnv, type EnvFiles } from './roster-env';

function files(contents: string | null): EnvFiles {
  return {
    exists: () => contents !== null,
    read: () => contents ?? '',
  };
}

const DEV_FILE = [
  "SSMS_ENV_NAME='dev'",
  "SSMS_EXPECT_PROJECT_REF='devref'",
  "SUPABASE_URL='https://devref.supabase.co'",
  "SUPABASE_SECRET_KEY='sb_secret_x'",
].join('\n');

describe('loadSsmsEnv', () => {
  it('requires SSMS_ENV to be dev or prod', () => {
    expect(() => loadSsmsEnv('/repo', {}, files(null))).toThrow(
      /There is no default/,
    );
    expect(() =>
      loadSsmsEnv('/repo', { SSMS_ENV: 'staging' }, files(null)),
    ).toThrow(/got: 'staging'/);
  });

  it('loads .env.<env> without overriding exported values', () => {
    const env: Record<string, string | undefined> = {
      SSMS_ENV: 'dev',
      SUPABASE_SECRET_KEY: 'from-shell',
    };
    const read = jest.fn(() => DEV_FILE);
    loadSsmsEnv('/repo', env, { exists: () => true, read });
    expect(read).toHaveBeenCalledWith('/repo/.env.dev');
    expect(env.SUPABASE_URL).toBe('https://devref.supabase.co');
    expect(env.SUPABASE_SECRET_KEY).toBe('from-shell');
  });

  it('accepts already-exported variables when the file is absent', () => {
    expect(() =>
      loadSsmsEnv(
        '/repo',
        {
          SSMS_ENV: 'dev',
          SUPABASE_URL: 'https://x.supabase.co',
          SUPABASE_SECRET_KEY: 'k',
        },
        files(null),
      ),
    ).not.toThrow();
  });

  it('refuses a file that declares another environment', () => {
    expect(() =>
      loadSsmsEnv('/repo', { SSMS_ENV: 'prod' }, files(DEV_FILE)),
    ).toThrow(/declares SSMS_ENV_NAME=dev but was loaded as 'prod'/);
  });

  it('refuses a project ref mismatch', () => {
    expect(() =>
      loadSsmsEnv(
        '/repo',
        { SSMS_ENV: 'dev', SUPABASE_URL: 'https://other.supabase.co' },
        files(DEV_FILE),
      ),
    ).toThrow(/expected 'devref' but SUPABASE_URL resolves to 'other'/);
    expect(() =>
      loadSsmsEnv(
        '/repo',
        { SSMS_ENV: 'dev', SUPABASE_URL: 'nope' },
        files(DEV_FILE),
      ),
    ).toThrow(/resolves to ''/);
  });

  it('requires the Supabase URL and secret key', () => {
    expect(() =>
      loadSsmsEnv('/repo', { SSMS_ENV: 'dev' }, files(null)),
    ).toThrow('SUPABASE_URL is not set (expected in /repo/.env.dev).');
  });

  it('uses the real filesystem by default', () => {
    expect(() =>
      loadSsmsEnv('/definitely/not/a/repo', { SSMS_ENV: 'dev' }),
    ).toThrow(/SUPABASE_URL is not set/);
  });

  describe('portal links in prod emails', () => {
    const PROD_FILE = [
      "SSMS_ENV_NAME='prod'",
      "SUPABASE_URL='https://prodref.supabase.co'",
      "SUPABASE_SECRET_KEY='sb_secret_p'",
    ].join('\n');

    it('defaults to the production portal when PORTAL_URL is unset', () => {
      const env: Record<string, string | undefined> = { SSMS_ENV: 'prod' };
      loadSsmsEnv('/repo', env, files(PROD_FILE));
      expect(env.PORTAL_URL).toBe('https://app.ssnow.club');
    });

    it('keeps an explicit PORTAL_URL', () => {
      const env: Record<string, string | undefined> = {
        SSMS_ENV: 'prod',
        PORTAL_URL: 'https://portal.example.com',
      };
      loadSsmsEnv('/repo', env, files(PROD_FILE));
      expect(env.PORTAL_URL).toBe('https://portal.example.com');
    });

    it.each([
      'http://localhost:5173',
      'http://127.0.0.1:5173/',
      'HTTP://LOCALHOST',
    ])('refuses %s', (url) => {
      expect(() =>
        loadSsmsEnv(
          '/repo',
          { SSMS_ENV: 'prod', PORTAL_URL: url },
          files(PROD_FILE),
        ),
      ).toThrow(/a local address/);
    });

    it('leaves dev on its local default', () => {
      const env: Record<string, string | undefined> = { SSMS_ENV: 'dev' };
      loadSsmsEnv('/repo', env, files(DEV_FILE));
      expect(env.PORTAL_URL).toBeUndefined();
    });
  });
});
