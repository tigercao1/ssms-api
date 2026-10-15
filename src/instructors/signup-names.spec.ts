import { signupNamesFromMetadata } from './signup-names';

describe('signupNamesFromMetadata', () => {
  it('uses the nickname as the display name', () => {
    expect(
      signupNamesFromMetadata({
        first_name: 'Jane',
        last_name: 'Doe',
        nickname: 'JJ',
      }),
    ).toEqual({ firstName: 'Jane', lastName: 'Doe', displayNameEn: 'JJ' });
  });

  it('falls back to first and last name without a nickname', () => {
    expect(
      signupNamesFromMetadata({ first_name: 'Jane', last_name: 'Doe' }),
    ).toEqual({
      firstName: 'Jane',
      lastName: 'Doe',
      displayNameEn: 'Jane Doe',
    });
  });

  it('falls back to whichever name is present', () => {
    expect(signupNamesFromMetadata({ last_name: 'Doe' })).toEqual({
      firstName: null,
      lastName: 'Doe',
      displayNameEn: 'Doe',
    });
  });

  it('trims names and treats blanks as absent', () => {
    expect(
      signupNamesFromMetadata({
        first_name: '  Jane  ',
        last_name: '   ',
        nickname: '',
      }),
    ).toEqual({ firstName: 'Jane', lastName: null, displayNameEn: 'Jane' });
  });

  it('treats non-string values as absent', () => {
    expect(
      signupNamesFromMetadata({
        first_name: 42,
        last_name: { value: 'Doe' },
        nickname: ['JJ'],
      }),
    ).toEqual({ firstName: null, lastName: null, displayNameEn: null });
  });

  it('returns no names without metadata', () => {
    expect(signupNamesFromMetadata(undefined)).toEqual({
      firstName: null,
      lastName: null,
      displayNameEn: null,
    });
  });

  it('caps each name and the combined display name at 100 characters', () => {
    const long = 'a'.repeat(150);
    const names = signupNamesFromMetadata({
      first_name: long,
      last_name: long,
      nickname: long,
    });
    expect(names.firstName).toBe('a'.repeat(100));
    expect(names.lastName).toBe('a'.repeat(100));
    expect(names.displayNameEn).toBe('a'.repeat(100));
    expect(
      signupNamesFromMetadata({ first_name: long, last_name: 'Doe' })
        .displayNameEn,
    ).toBe('a'.repeat(100));
  });

  it('counts characters, not UTF-16 code units, when capping', () => {
    const names = signupNamesFromMetadata({ first_name: '😀'.repeat(150) });
    expect(Array.from(names.firstName ?? '')).toHaveLength(100);
  });
});
