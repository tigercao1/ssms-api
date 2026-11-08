import {
  baseHandle,
  handleCandidates,
  type HandleSource,
  isFallbackHandle,
} from './instructor-handle';

const ID = '3f1c2b7a-9d4e-4c1a-8b2f-6a7e5d4c3b2a';

function source(overrides: Partial<HandleSource> = {}): HandleSource {
  return {
    id: ID,
    display_name_en: 'Eddie Chen',
    first_name: null,
    ...overrides,
  };
}

describe('instructor handles', () => {
  it.each([
    ['Eddie', 'eddie'],
    ['  Eddie  Chen ', 'eddie-chen'],
    ['Zoë O’Brien', 'zoe-o-brien'],
    ['小李 Vincent', 'vincent'],
    ['Lele 乐乐', 'lele'],
    ['A'.repeat(70), 'a'.repeat(60)],
  ])('slugifies %j to %j', (name, expected) => {
    expect(baseHandle(source({ display_name_en: name }))).toBe(expected);
  });

  it('prefers the English display name over the legal first name', () => {
    expect(
      baseHandle(source({ display_name_en: 'Vincent', first_name: 'Wei' })),
    ).toBe('vincent');
  });

  it('uses the legal first name when the English display name has no Latin characters', () => {
    expect(
      baseHandle(source({ display_name_en: '囧泥', first_name: 'Yuhan' })),
    ).toBe('yuhan');
  });

  it('falls back to the uuid prefix when neither English nor legal first name slugifies', () => {
    expect(baseHandle(source({ display_name_en: '小李' }))).toBe(
      'instructor-3f1c2b7a',
    );
    expect(
      baseHandle(source({ display_name_en: '乐乐', first_name: '可平' })),
    ).toBe('instructor-3f1c2b7a');
    expect(baseHandle(source({ display_name_en: '', first_name: '  ' }))).toBe(
      'instructor-3f1c2b7a',
    );
  });

  it('recognises only its own uuid-prefix fallback handles', () => {
    expect(isFallbackHandle('instructor-3f1c2b7a', ID)).toBe(true);
    expect(isFallbackHandle('instructor-3f1c2b7a-2', ID)).toBe(true);
    expect(isFallbackHandle('instructor-3f1c2b7a-3f1c', ID)).toBe(true);
    expect(isFallbackHandle('instructor-3f1c2b7a-3f1c2b', ID)).toBe(true);
    expect(isFallbackHandle('instructor-3f1c2b7a-3f1c2b7a', ID)).toBe(true);
    expect(isFallbackHandle('instructor-3f1c2b7a-9b8a', ID)).toBe(false);
    expect(isFallbackHandle('instructor-9b8a7c6d', ID)).toBe(false);
    expect(isFallbackHandle('instructor-3f1c2b7a-x', ID)).toBe(false);
    expect(isFallbackHandle('lele', ID)).toBe(false);
    expect(isFallbackHandle('lele-3f1c', ID)).toBe(false);
    expect(isFallbackHandle('eddie-2', ID)).toBe(false);
  });

  it('tries the plain handle, then 4, 6 and 8 hex of the instructor id', () => {
    expect(handleCandidates('eddie', ID)).toEqual([
      'eddie',
      'eddie-3f1c',
      'eddie-3f1c2b',
      'eddie-3f1c2b7a',
    ]);
  });
});
