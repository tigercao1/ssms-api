import {
  ALREADY_PAID,
  amountCents,
  type ClassLine,
  classLine,
  CORRECTION,
  instructorTotals,
  LATE,
  LATE_CANCEL,
  lateLines,
  NEEDS_RATE,
  type PayableClass,
  type PayableRate,
  rateAmountCents,
  REASSIGNED,
  settledLine,
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

describe('lateLines', () => {
  const paid = (
    amount: number,
    overrides: Partial<ClassLine> = {},
  ): ClassLine => ({
    ...classLine(lesson(90), [rate(40, 'hour')]),
    amount,
    ...overrides,
  });
  const cancelled = (cls: PayableClass): PayableClass => ({
    ...cls,
    status: 'cancelled',
  });

  it('pays a never-paid lesson at the current rate', () => {
    expect(lateLines(lesson(90), [], [rate(40, 'hour')], true)).toEqual([
      expect.objectContaining({ amount: 60, hourlyRate: 40, flags: [LATE] }),
    ]);
  });

  it('flags a never-paid lesson without a rate even at zero', () => {
    expect(lateLines(lesson(90), [], [], true)).toEqual([
      expect.objectContaining({ amount: 0, flags: [LATE, NEEDS_RATE] }),
    ]);
  });

  it('ignores a rate change, a zero-rate payment and an already-paid move', () => {
    const rates = [rate(50, 'hour')];
    expect(lateLines(lesson(90), [paid(60)], rates, true)).toEqual([]);
    expect(
      lateLines(
        lesson(90),
        [paid(0, { flags: [NEEDS_RATE], hourlyRate: null })],
        rates,
        true,
      ),
    ).toEqual([]);
    expect(
      lateLines(
        lesson(90),
        [paid(60), paid(0, { flags: [ALREADY_PAID] })],
        rates,
        true,
      ),
    ).toEqual([]);
  });

  it('leaves a cancelled lesson that was never paid alone', () => {
    expect(
      lateLines(cancelled(lesson(90)), [], [rate(40, 'hour')], true),
    ).toEqual([]);
  });

  it('repays a restored lesson at the amount it was first paid', () => {
    const lines = [paid(60), paid(-60, { flags: [LATE_CANCEL] })];
    expect(lateLines(lesson(90), lines, [rate(50, 'hour')], true)).toEqual([
      expect.objectContaining({ amount: 60, hourlyRate: 40, flags: [LATE] }),
    ]);
  });

  it('labels a refund on a cancelled lesson as a late cancel correction (S3a)', () => {
    const lines = [paid(-60, { flags: [LATE_CANCEL] })];
    expect(lateLines(cancelled(lesson(90)), lines, [], true)).toEqual([
      expect.objectContaining({
        amount: 60,
        classStatus: 'cancelled',
        flags: [LATE_CANCEL, CORRECTION],
      }),
    ]);
  });

  it('labels a take-back on a lesson that still stands as a late correction (S9)', () => {
    const lines = [paid(60), paid(60, { flags: [LATE] })];
    expect(lateLines(lesson(90), lines, [], true)).toEqual([
      expect.objectContaining({
        amount: -60,
        classStatus: 'completed',
        flags: [LATE, CORRECTION],
      }),
    ]);
  });

  it('owes what the first paying line paid, so a top-up is not repeated', () => {
    const lines = [
      paid(-60, { flags: [LATE_CANCEL] }),
      paid(0, { flags: [ALREADY_PAID] }),
      paid(120, { flags: [LATE] }),
    ];
    expect(lateLines(lesson(90), lines, [rate(50, 'hour')], true)).toEqual([]);
  });

  it('repays a restored lesson after the period that first paid it is reopened and finalized again', () => {
    const lines = [
      paid(-60, { flags: [LATE_CANCEL] }),
      paid(60, { flags: [LATE] }),
      paid(0, { flags: [ALREADY_PAID], hourlyRate: 50 }),
    ];
    expect(lateLines(lesson(90), lines, [rate(50, 'hour')], true)).toEqual([
      expect.objectContaining({ amount: 60, hourlyRate: 40, flags: [LATE] }),
    ]);
  });

  it('leaves a never-paid lesson in an open period to that period', () => {
    expect(lateLines(lesson(90), [], [rate(40, 'hour')], false)).toEqual([]);
    expect(
      lateLines(lesson(90), [paid(0, { flags: [ALREADY_PAID] })], [], false),
    ).toEqual([]);
  });

  it('settles a paid lesson moved into an open period and given to another instructor in the current period', () => {
    const bo = { ...lesson(90), instructorId: 'bo' };
    const rates = [{ ...rate(80, 'hour'), instructorId: 'bo' }];
    expect(lateLines(bo, [paid(60)], rates, false)).toEqual([
      expect.objectContaining({
        instructorId: 'bo',
        amount: 120,
        flags: [LATE, REASSIGNED],
      }),
      expect.objectContaining({
        instructorId: ADA,
        amount: -60,
        flags: [LATE_CANCEL, REASSIGNED],
      }),
    ]);
  });

  it('takes the pay back from an instructor who left the lesson and pays the new one at their own rate', () => {
    const bo = { ...lesson(90), instructorId: 'bo' };
    const rates = [
      rate(40, 'hour'),
      { ...rate(80, 'hour'), instructorId: 'bo' },
    ];
    expect(lateLines(bo, [paid(60)], rates, true)).toEqual([
      expect.objectContaining({
        instructorId: 'bo',
        amount: 120,
        hourlyRate: 80,
        flags: [LATE, REASSIGNED],
      }),
      expect.objectContaining({
        instructorId: ADA,
        amount: -60,
        hourlyRate: 40,
        minutes: 90,
        flags: [LATE_CANCEL, REASSIGNED],
      }),
    ]);
  });

  it('repays a returning instructor what they were first paid', () => {
    const lines = [
      paid(60),
      paid(-60, { flags: [LATE_CANCEL, REASSIGNED] }),
      paid(120, {
        instructorId: 'bo',
        hourlyRate: 80,
        flags: [LATE, REASSIGNED],
      }),
    ];
    expect(lateLines(lesson(90), lines, [rate(50, 'hour')], true)).toEqual([
      expect.objectContaining({
        instructorId: ADA,
        amount: 60,
        flags: [LATE, REASSIGNED],
      }),
      expect.objectContaining({
        instructorId: 'bo',
        amount: -120,
        flags: [LATE_CANCEL, REASSIGNED],
      }),
    ]);
  });

  it('reverses the pay of a cancelled lesson for every instructor who still holds it', () => {
    const bo = cancelled({ ...lesson(90), instructorId: 'bo' });
    const lines = [
      paid(60),
      paid(120, { instructorId: 'bo', flags: [LATE, REASSIGNED] }),
    ];
    expect(lateLines(bo, lines, [], true)).toEqual([
      expect.objectContaining({
        instructorId: 'bo',
        amount: -120,
        flags: [LATE_CANCEL],
      }),
      expect.objectContaining({
        instructorId: ADA,
        amount: -60,
        flags: [LATE_CANCEL, REASSIGNED],
      }),
    ]);
  });
});

describe('settledLine', () => {
  const live = classLine(lesson(90), [rate(50, 'hour')]);
  const paid = (amount: number, flags: string[] = []): ClassLine => ({
    ...classLine(lesson(90), [rate(40, 'hour')]),
    amount,
    flags,
  });

  it('keeps a lesson nobody holds pay for', () => {
    expect(settledLine(live, [])).toBe(live);
    expect(settledLine(live, [paid(0, [ALREADY_PAID])])).toBe(live);
    expect(
      settledLine(live, [
        { ...paid(60), instructorId: 'bo' },
        { ...paid(-60, [LATE_CANCEL, REASSIGNED]), instructorId: 'bo' },
      ]),
    ).toBe(live);
  });

  it('marks a lesson already paid to its instructor elsewhere, even at a net of zero', () => {
    expect(settledLine(live, [paid(60)])).toMatchObject({
      amount: 0,
      flags: [ALREADY_PAID],
    });
    expect(settledLine(live, [paid(0, [NEEDS_RATE])])).toMatchObject({
      flags: [ALREADY_PAID],
    });
    expect(
      settledLine(live, [paid(60), paid(-60, [LATE_CANCEL])]),
    ).toMatchObject({ amount: 0, flags: [ALREADY_PAID] });
  });

  it('marks a lesson another instructor still holds pay for', () => {
    expect(
      settledLine(live, [{ ...paid(60), instructorId: 'bo' }]),
    ).toMatchObject({ amount: 0, flags: [ALREADY_PAID] });
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

  it('counts a correction in money only', () => {
    const line = classLine(lesson(90), [rate(40, 'hour')]);
    const [total] = instructorTotals(
      [
        { ...line, amount: 60, flags: [LATE_CANCEL, CORRECTION] },
        { ...line, amount: -60, flags: [LATE, CORRECTION] },
        { ...line, amount: 60, flags: [LATE, REASSIGNED] },
      ],
      [],
    );
    expect(total).toMatchObject({ lessons: 1, minutes: 90, lessonAmount: 60 });
  });
});
