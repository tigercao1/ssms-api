import { isIsoDate, resolveRate } from './pay-rates';

const TYPE = 'type-private-2h';
const OTHER_TYPE = 'type-group';
const EDDIE = 'eddie';
const ERIC = 'eric';

const rate = (
  id: string,
  instructorId: string | null,
  effectiveFrom: string,
  effectiveTo: string | null = null,
  lessonTypeId = TYPE,
) => ({ id, lessonTypeId, instructorId, effectiveFrom, effectiveTo });

const rates = [
  rate('default-2026', null, '2026-11-01', '2026-12-31'),
  rate('default-2027', null, '2027-01-01'),
  rate('eddie-override', EDDIE, '2026-12-15', '2027-02-28'),
  rate('group-default', null, '2026-01-01', null, OTHER_TYPE),
];

describe('resolveRate', () => {
  it.each([
    [EDDIE, '2026-11-01', 'default-2026'],
    [EDDIE, '2026-12-14', 'default-2026'],
    [EDDIE, '2026-12-15', 'eddie-override'],
    [EDDIE, '2027-02-28', 'eddie-override'],
    [EDDIE, '2027-03-01', 'default-2027'],
    [ERIC, '2026-12-31', 'default-2026'],
    [ERIC, '2027-01-01', 'default-2027'],
    [ERIC, '2040-06-01', 'default-2027'],
  ])('%s on %s → %s', (instructorId, date, expected) => {
    expect(resolveRate(rates, instructorId, TYPE, date)?.id).toBe(expected);
  });

  it('returns null before any rate is effective or for a type without rates', () => {
    expect(resolveRate(rates, EDDIE, TYPE, '2026-10-31')).toBeNull();
    expect(resolveRate(rates, EDDIE, 'type-unknown', '2027-01-01')).toBeNull();
    expect(resolveRate([], EDDIE, TYPE, '2027-01-01')).toBeNull();
  });

  it('never uses another lesson type or another instructor’s override', () => {
    expect(resolveRate(rates, ERIC, OTHER_TYPE, '2026-12-20')?.id).toBe(
      'group-default',
    );
    expect(
      resolveRate(
        [rate('eric-only', ERIC, '2026-01-01')],
        EDDIE,
        TYPE,
        '2026-06-01',
      ),
    ).toBeNull();
  });

  it('prefers the latest start when stored rates overlap', () => {
    const overlapping = [
      rate('older', null, '2026-01-01'),
      rate('newer', null, '2026-06-01'),
    ];
    expect(resolveRate(overlapping, EDDIE, TYPE, '2026-07-01')?.id).toBe(
      'newer',
    );
  });

  it('rejects a date that is not YYYY-MM-DD', () => {
    expect(() => resolveRate(rates, EDDIE, TYPE, '2026-02-30')).toThrow(
      RangeError,
    );
    expect(() =>
      resolveRate(rates, EDDIE, TYPE, '2026-12-15T10:00:00Z'),
    ).toThrow(RangeError);
  });
});

describe('isIsoDate', () => {
  it.each([
    ['2026-12-15', true],
    ['2028-02-29', true],
    ['2027-02-29', false],
    ['2026-13-01', false],
    ['15/12/2026', false],
    ['', false],
  ])('%s → %s', (value, expected) => {
    expect(isIsoDate(value)).toBe(expected);
  });
});
