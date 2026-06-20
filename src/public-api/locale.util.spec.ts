import { pickLocalized, pickLocalizedNullable } from './locale.util';

describe('pickLocalized', () => {
  it('returns zh when locale is zh-CN and a non-blank zh value exists', () => {
    expect(pickLocalized('zh-CN', 'Jane', '简')).toBe('简');
  });

  it('falls back to en when zh is null', () => {
    expect(pickLocalized('zh-CN', 'Jane', null)).toBe('Jane');
  });

  it('treats a blank/whitespace zh as missing and falls back to en', () => {
    expect(pickLocalized('zh-CN', 'Jane', '   ')).toBe('Jane');
    expect(pickLocalized('zh-CN', 'Jane', '')).toBe('Jane');
  });

  it('always returns en when locale is en', () => {
    expect(pickLocalized('en', 'Jane', '简')).toBe('Jane');
  });

  it('returns empty string when en is null/undefined', () => {
    expect(pickLocalized('en', null, null)).toBe('');
    expect(pickLocalized('zh-CN', undefined, null)).toBe('');
  });
});

describe('pickLocalizedNullable', () => {
  it('returns zh when present for zh-CN', () => {
    expect(pickLocalizedNullable('zh-CN', 'hi', '你好')).toBe('你好');
  });

  it('preserves null when en is absent (unlike pickLocalized)', () => {
    expect(pickLocalizedNullable('en', null, null)).toBeNull();
    expect(pickLocalizedNullable('zh-CN', null, '')).toBeNull();
  });

  it('falls back to en for zh-CN when zh blank', () => {
    expect(pickLocalizedNullable('zh-CN', 'hi', '')).toBe('hi');
  });
});
