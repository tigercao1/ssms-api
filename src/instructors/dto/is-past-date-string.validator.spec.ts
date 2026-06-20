import { IsPastDateStringConstraint } from './is-past-date-string.validator';

describe('IsPastDateStringConstraint', () => {
  const c = new IsPastDateStringConstraint();

  it('accepts null/undefined (optional)', () => {
    expect(c.validate(null)).toBe(true);
    expect(c.validate(undefined)).toBe(true);
  });

  it('accepts a valid past date', () => {
    expect(c.validate('1990-05-12')).toBe(true);
  });

  it('rejects a future date', () => {
    expect(c.validate('2999-01-01')).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(c.validate(12345)).toBe(false);
    expect(c.validate({})).toBe(false);
  });

  it('rejects a malformed string', () => {
    expect(c.validate('05/12/1990')).toBe(false);
  });

  it('rejects a well-formed but invalid calendar date', () => {
    expect(c.validate('2022-13-45')).toBe(false);
  });

  it('exposes a default message', () => {
    expect(c.defaultMessage()).toMatch(/past date/);
  });
});
