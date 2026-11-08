import {
  baseHandle,
  handleCandidate,
  type HandleSource,
  isFallbackHandle,
} from './instructor-handle';

const ID = '3f1c2b7a-9d4e-4c1a-8b2f-6a7e5d4c3b2a';

function source(overrides: Partial<HandleSource> = {}): HandleSource {
  return {
    id: ID,
    display_name_en: 'Eddie Chen',
    display_name_zh: null,
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

  it('prefers the English display name over the legal first name and the Chinese name', () => {
    expect(
      baseHandle(
        source({
          display_name_en: 'Vincent',
          first_name: 'Wei',
          display_name_zh: '小李',
        }),
      ),
    ).toBe('vincent');
  });

  it('uses the legal first name when the English display name has no Latin characters', () => {
    expect(
      baseHandle(
        source({
          display_name_en: '囧泥',
          first_name: 'Yuhan',
          display_name_zh: '小李',
        }),
      ),
    ).toBe('yuhan');
  });

  it('uses the pinyin of the Chinese display name when neither English name slugifies', () => {
    expect(
      baseHandle(
        source({
          display_name_en: '乐乐',
          first_name: '可平',
          display_name_zh: '乐乐',
        }),
      ),
    ).toBe('le-le');
    expect(
      baseHandle(source({ display_name_en: '', display_name_zh: '吕布' })),
    ).toBe('lu-bu');
  });

  it('falls back to the uuid prefix when no name has usable characters', () => {
    expect(baseHandle(source({ display_name_en: '小李' }))).toBe(
      'instructor-3f1c2b7a',
    );
    expect(
      baseHandle(source({ display_name_en: '', display_name_zh: '  ' })),
    ).toBe('instructor-3f1c2b7a');
  });

  it('recognises only its own uuid-prefix fallback handles', () => {
    expect(isFallbackHandle('instructor-3f1c2b7a', ID)).toBe(true);
    expect(isFallbackHandle('instructor-3f1c2b7a-2', ID)).toBe(true);
    expect(isFallbackHandle('instructor-9b8a7c6d', ID)).toBe(false);
    expect(isFallbackHandle('instructor-3f1c2b7a-x', ID)).toBe(false);
    expect(isFallbackHandle('lele', ID)).toBe(false);
  });

  it('numbers collisions from -2 upwards', () => {
    expect(handleCandidate('eddie', 1)).toBe('eddie');
    expect(handleCandidate('eddie', 2)).toBe('eddie-2');
    expect(handleCandidate('eddie', 3)).toBe('eddie-3');
  });
});
