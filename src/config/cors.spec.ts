import { buildCorsOptions, parseAllowedOrigins } from './cors';

describe('parseAllowedOrigins', () => {
  it('returns [] for undefined or empty (deny-all default preserved)', () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins('')).toEqual([]);
    expect(parseAllowedOrigins('   ')).toEqual([]);
  });

  it('splits, trims, and drops empty entries', () => {
    expect(
      parseAllowedOrigins(
        ' https://portal.example , http://localhost:5173 ,, ',
      ),
    ).toEqual(['https://portal.example', 'http://localhost:5173']);
  });

  it('handles a single origin', () => {
    expect(parseAllowedOrigins('https://portal.example')).toEqual([
      'https://portal.example',
    ]);
  });
});

describe('buildCorsOptions', () => {
  it('allow-lists the given origins, Bearer-only (no credentials)', () => {
    const opts = buildCorsOptions(['https://portal.example']);
    expect(opts.origin).toEqual(['https://portal.example']);
    expect(opts.credentials).toBe(false);
    expect(opts.allowedHeaders).toContain('Authorization');
    expect(opts.methods).toEqual(
      expect.arrayContaining(['GET', 'POST', 'PATCH', 'OPTIONS']),
    );
  });
});
