import {
  amountCents,
  classLine,
  NEEDS_RATE,
  type PayableClass,
  type PayableRate,
  rateAmountCents,
} from './payroll-lines';

const TYPE = 'type-group';
const ADA = 'ada';

const lesson = (minutes: number): PayableClass => ({
  id: `class-${minutes}`,
  instructorId: ADA,
  lessonTypeId: TYPE,
  lessonTypeName: 'Group',
  status: 'completed',
  startsAt: '2026-01-05T15:00:00.000Z',
  endsAt: new Date(
    Date.parse('2026-01-05T15:00:00.000Z') + minutes * 60_000,
  ).toISOString(),
  customerNames: [],
});

const rate = (
  hourlyRate: number | string,
  rateUnit: PayableRate['rateUnit'],
): PayableRate => ({
  lessonTypeId: TYPE,
  instructorId: null,
  effectiveFrom: '2025-01-01',
  effectiveTo: null,
  hourlyRate,
  rateUnit,
  currency: 'CAD',
});

describe('classLine', () => {
  it.each([1, 30, 90, 120, 480, 1440])(
    'pays a daily rate once for a %i-minute lesson',
    (minutes) => {
      expect(classLine(lesson(minutes), [rate('400', 'day')])).toMatchObject({
        minutes,
        hourlyRate: 400,
        rateUnit: 'day',
        amount: 400,
        flags: [],
      });
    },
  );

  it.each([
    [90, 37.33, 56],
    [120, 90, 180],
    [45, 33.33, 25],
    [0, 90, 0],
  ])(
    'prices %i minutes at an hourly %d as %d',
    (minutes, hourlyRate, amount) => {
      expect(
        classLine(lesson(minutes), [rate(hourlyRate, 'hour')]),
      ).toMatchObject({ rateUnit: 'hour', hourlyRate, amount });
    },
  );

  it('flags a lesson without a rate as hourly with no amount', () => {
    expect(classLine(lesson(90), [])).toMatchObject({
      hourlyRate: null,
      rateUnit: 'hour',
      amount: 0,
      flags: [NEEDS_RATE],
    });
  });
});

describe('rateAmountCents', () => {
  it('keeps the hourly math and ignores minutes for a daily rate', () => {
    expect(rateAmountCents('37.33', 'hour', 90)).toBe(amountCents('37.33', 90));
    expect(rateAmountCents('400.50', 'day', 30)).toBe(40050);
    expect(rateAmountCents(400, 'day', 600)).toBe(40000);
  });
});
