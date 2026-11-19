import {
  ALREADY_PAID,
  amountCents,
  type ClassLine,
  classLine,
  instructorTotals,
  LATE,
  LATE_CANCEL,
  lateLine,
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

describe('lateLine', () => {
  const paid = (
    amount: number,
    overrides: Partial<ClassLine> = {},
  ): ClassLine => ({
    ...classLine(lesson(90), [rate(40, 'hour')]),
    amount,
    ...overrides,
  });

  it('pays a never-paid lesson at the current rate', () => {
    expect(lateLine(lesson(90), [], [rate(40, 'hour')])).toMatchObject({
      amount: 60,
      hourlyRate: 40,
      flags: [LATE],
    });
  });

  it('flags a never-paid lesson without a rate even at zero', () => {
    expect(lateLine(lesson(90), [], [])).toMatchObject({
      amount: 0,
      flags: [LATE, NEEDS_RATE],
    });
  });

  it('ignores a rate change, a zero-rate payment and an already-paid move', () => {
    const rates = [rate(50, 'hour')];
    expect(lateLine(lesson(90), [paid(60)], rates)).toBeNull();
    expect(
      lateLine(lesson(90), [paid(0, { flags: [NEEDS_RATE] })], rates),
    ).toBeNull();
    expect(
      lateLine(
        lesson(90),
        [paid(60), paid(0, { flags: [ALREADY_PAID] })],
        rates,
      ),
    ).toBeNull();
  });

  it('leaves a cancelled lesson that was never paid alone', () => {
    expect(
      lateLine({ ...lesson(90), status: 'cancelled' }, [], [rate(40, 'hour')]),
    ).toBeNull();
  });

  it('reverses the net paid to the instructor who was paid, at the paid rate and minutes', () => {
    const moved = {
      ...lesson(120),
      instructorId: 'bo',
      status: 'cancelled' as const,
    };
    expect(lateLine(moved, [paid(60)], [rate(50, 'hour')])).toMatchObject({
      instructorId: ADA,
      classStatus: 'cancelled',
      minutes: 90,
      hourlyRate: 40,
      amount: -60,
      flags: [LATE_CANCEL],
    });
  });

  it('repays a restored lesson at the amount it was first paid', () => {
    const lines = [paid(60), paid(-60, { flags: [LATE_CANCEL] })];
    expect(lateLine(lesson(90), lines, [rate(50, 'hour')])).toMatchObject({
      amount: 60,
      hourlyRate: 40,
      flags: [LATE],
    });
  });

  it('takes back an overpayment on a lesson that still stands', () => {
    const lines = [paid(60), paid(60, { flags: [LATE] })];
    expect(lateLine(lesson(90), lines, [])).toMatchObject({
      amount: -60,
      flags: [LATE_CANCEL],
    });
  });
});

describe('instructorTotals', () => {
  it('counts a late cancel as a lesson and its minutes taken back', () => {
    const late = classLine(lesson(90), [rate(40, 'hour')]);
    const [total] = instructorTotals(
      [
        { ...late, flags: [LATE] },
        { ...late, amount: -30, minutes: 45, flags: [LATE_CANCEL] },
      ],
      [],
    );
    expect(total).toMatchObject({
      lessons: 0,
      minutes: 45,
      lessonAmount: 30,
      total: 30,
    });
  });
});
