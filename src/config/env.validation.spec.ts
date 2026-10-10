import { validateEnv } from './env.validation';

const base = {
  SUPABASE_URL: 'http://localhost',
  SUPABASE_SECRET_KEY: 'secret',
  SUPABASE_STORAGE_BUCKET: 'instructor-public',
};

describe('validateEnv', () => {
  it('accepts the required Supabase config', () => {
    expect(validateEnv(base)).toBe(base);
  });

  it('lists missing required variables', () => {
    expect(() => validateEnv({ SUPABASE_URL: 'x' })).toThrow(
      'Missing required environment variables: SUPABASE_SECRET_KEY, SUPABASE_STORAGE_BUCKET.',
    );
  });

  it('requires DOCS_INTERNAL_TOKEN in production only', () => {
    expect(() => validateEnv({ ...base, NODE_ENV: 'production' })).toThrow(
      'DOCS_INTERNAL_TOKEN',
    );
    expect(() =>
      validateEnv({ ...base, NODE_ENV: 'production', DOCS_INTERNAL_TOKEN: '' }),
    ).toThrow('DOCS_INTERNAL_TOKEN');
    const prod = { ...base, NODE_ENV: 'production', DOCS_INTERNAL_TOKEN: 't' };
    expect(validateEnv(prod)).toBe(prod);
    expect(validateEnv({ ...base, NODE_ENV: 'development' })).toBeDefined();
  });
});
