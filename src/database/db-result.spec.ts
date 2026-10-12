import {
  check,
  DatabaseError,
  hasCode,
  ilikeAny,
  likePattern,
  searchTokens,
} from './db-result';

describe('db-result helpers', () => {
  it('check throws a DatabaseError that keeps the code', () => {
    expect(() => check(null, 'load')).not.toThrow();
    let thrown: unknown;
    try {
      check({ message: 'dup', code: '23505' }, 'save thing');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DatabaseError);
    expect((thrown as Error).message).toBe('Failed to save thing: dup');
    expect(hasCode(thrown, '23505')).toBe(true);
    expect(hasCode(thrown, '23P01')).toBe(false);
    expect(hasCode(new Error('x'), '23505')).toBe(false);
  });

  it('likePattern escapes LIKE wildcards and drops PostgREST stars', () => {
    expect(likePattern('wang')).toBe('%wang%');
    expect(likePattern('50%_off\\*')).toBe('%50\\%\\_off\\\\%');
  });

  it('ilikeAny quotes the value so commas and parentheses stay literal', () => {
    expect(ilikeAny(['a', 'b'], 'x,y(z)"')).toBe(
      'a.ilike."%x,y(z)\\"%",b.ilike."%x,y(z)\\"%"',
    );
  });

  it('searchTokens splits on whitespace and caps the count', () => {
    expect(searchTokens('  Eric   Wang ')).toEqual(['Eric', 'Wang']);
    expect(searchTokens('*')).toEqual([]);
    expect(searchTokens(undefined)).toEqual([]);
    expect(searchTokens('a b c d e f g')).toHaveLength(5);
  });
});
