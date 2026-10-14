import {
  addDays,
  certificationKey,
  certificationState,
  currentUploads,
  daysBetween,
  expiryReminderDue,
  expiryReminderSent,
  isCertificationSatisfied,
  torontoStartOfDay,
  torontoToday,
} from './certification-validity';

const TODAY = '2026-10-12';

describe('certificationState', () => {
  const approved = (validUntil: string) => ({
    reviewStatus: 'approved' as const,
    validUntil,
  });

  it('is missing without an upload', () => {
    expect(certificationState(null, TODAY)).toBe('missing');
    expect(certificationState(undefined, TODAY)).toBe('missing');
  });

  it.each([
    ['2026-10-11', 'expired'],
    ['2026-10-12', 'expiring'],
    ['2026-11-11', 'expiring'],
    ['2026-11-12', 'valid'],
    ['2027-10-31', 'valid'],
  ])('approved until %s → %s', (validUntil, state) => {
    expect(certificationState(approved(validUntil), TODAY)).toBe(state);
  });

  it('is pending while awaiting review, unless already expired', () => {
    expect(
      certificationState(
        { reviewStatus: 'pending', validUntil: '2026-10-12' },
        TODAY,
      ),
    ).toBe('pending');
    expect(
      certificationState(
        { reviewStatus: 'pending', validUntil: '2027-10-12' },
        TODAY,
      ),
    ).toBe('pending');
    expect(
      certificationState(
        { reviewStatus: 'pending', validUntil: '2026-10-11' },
        TODAY,
      ),
    ).toBe('expired');
  });

  it('is rejected regardless of the date', () => {
    expect(
      certificationState(
        { reviewStatus: 'rejected', validUntil: '2030-01-01' },
        TODAY,
      ),
    ).toBe('rejected');
  });

  it('counts across month and leap-year boundaries', () => {
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2);
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1);
    expect(daysBetween('2026-10-12', '2026-10-11')).toBe(-1);
    expect(certificationState(approved('2028-03-29'), '2028-02-28')).toBe(
      'expiring',
    );
    expect(certificationState(approved('2028-03-30'), '2028-02-28')).toBe(
      'valid',
    );
  });

  it('rejects malformed dates', () => {
    expect(() => certificationState(approved('2026/10/12'), TODAY)).toThrow(
      'Expected a YYYY-MM-DD date',
    );
  });

  it('treats valid, expiring and pending as satisfied', () => {
    expect(isCertificationSatisfied('valid')).toBe(true);
    expect(isCertificationSatisfied('expiring')).toBe(true);
    expect(isCertificationSatisfied('pending')).toBe(true);
    expect(isCertificationSatisfied('expired')).toBe(false);
    expect(isCertificationSatisfied('missing')).toBe(false);
    expect(isCertificationSatisfied('rejected')).toBe(false);
  });
});

describe('torontoToday', () => {
  it('uses the America/Toronto calendar date', () => {
    expect(torontoToday(new Date('2026-10-13T03:30:00Z'))).toBe('2026-10-12');
    expect(torontoToday(new Date('2026-10-13T04:30:00Z'))).toBe('2026-10-13');
    expect(torontoToday(new Date('2027-01-15T04:59:00Z'))).toBe('2027-01-14');
    expect(torontoToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('is still the previous day at 22:00 Toronto when UTC has rolled over', () => {
    expect(torontoToday(new Date('2026-10-14T02:00:00Z'))).toBe('2026-10-13');
    expect(torontoToday(new Date('2026-10-14T03:59:59Z'))).toBe('2026-10-13');
    expect(torontoToday(new Date('2026-10-14T04:00:00Z'))).toBe('2026-10-14');
  });

  it('follows the DST change on 2026-11-01', () => {
    expect(torontoToday(new Date('2026-11-01T03:59:59Z'))).toBe('2026-10-31');
    expect(torontoToday(new Date('2026-11-01T04:00:00Z'))).toBe('2026-11-01');
    expect(torontoToday(new Date('2026-11-02T04:59:59Z'))).toBe('2026-11-01');
    expect(torontoToday(new Date('2026-11-02T05:00:00Z'))).toBe('2026-11-02');
  });
});

describe('torontoStartOfDay', () => {
  it.each([
    ['2026-10-13', '2026-10-13T04:00:00.000Z'],
    ['2026-11-01', '2026-11-01T04:00:00.000Z'],
    ['2026-11-02', '2026-11-02T05:00:00.000Z'],
    ['2027-01-15', '2027-01-15T05:00:00.000Z'],
    ['2027-03-14', '2027-03-14T05:00:00.000Z'],
    ['2027-03-15', '2027-03-15T04:00:00.000Z'],
  ])('starts %s at %s', (date, instant) => {
    expect(torontoStartOfDay(date)).toBe(instant);
    expect(torontoToday(new Date(instant))).toBe(date);
    expect(torontoToday(new Date(Date.parse(instant) - 1))).toBe(
      addDays(date, -1),
    );
  });
});

describe('currentUploads', () => {
  it('keeps the latest upload per (org, track)', () => {
    const uploads = [
      {
        id: 'a',
        org: 'csia',
        track: 'regular',
        insertedAt: '2026-01-01T00:00:00Z',
      },
      {
        id: 'b',
        org: 'csia',
        track: 'regular',
        insertedAt: '2026-03-01T00:00:00Z',
      },
      {
        id: 'c',
        org: 'csia',
        track: 'regular',
        insertedAt: '2026-02-01T00:00:00Z',
      },
      {
        id: 'd',
        org: 'casi',
        track: 'regular',
        insertedAt: '2025-01-01T00:00:00Z',
      },
    ] as const;
    const current = currentUploads(uploads);
    expect(current.size).toBe(2);
    expect(current.get(certificationKey('csia', 'regular'))?.id).toBe('b');
    expect(current.get('casi:regular')?.id).toBe('d');
    expect(current.get('csia:park')).toBeUndefined();
  });
});

describe('addDays', () => {
  it('moves across month, year and leap-day boundaries', () => {
    expect(addDays('2026-10-12', 30)).toBe('2026-11-11');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
    expect(addDays('2026-10-12', 0)).toBe('2026-10-12');
  });
});

describe('expiryReminderSent', () => {
  const VALID_UNTIL = '2026-11-30';

  it.each([
    [null, null],
    ['2026-10-31T09:00:00.000Z', 'expiring'],
    ['2026-11-30T23:59:59.000Z', 'expiring'],
    ['2026-12-01T00:00:00.000Z', 'expired'],
    ['2026-10-30T12:00:00.000Z', null],
  ])('sent at %s → %s', (sentAt, stage) => {
    expect(expiryReminderSent(sentAt, VALID_UNTIL)).toBe(stage);
  });
});

describe('expiryReminderDue', () => {
  const upload = (
    validUntil: string,
    overrides: Partial<Parameters<typeof expiryReminderDue>[0]> = {},
  ) => ({
    reviewStatus: 'approved' as const,
    validUntil,
    expiryReminderSentAt: null,
    ...overrides,
  });

  it.each([
    ['2026-11-12', null],
    ['2026-11-11', 'expiring'],
    ['2026-10-12', 'expiring'],
    ['2026-10-11', 'expired'],
    ['2026-10-05', 'expired'],
    ['2026-10-04', null],
  ])('nothing sent, valid until %s → %s', (validUntil, due) => {
    expect(expiryReminderDue(upload(validUntil), TODAY)).toBe(due);
  });

  it('sends the expiring email once', () => {
    expect(
      expiryReminderDue(
        upload('2026-11-11', { expiryReminderSentAt: '2026-10-12T08:00:00Z' }),
        TODAY,
      ),
    ).toBeNull();
  });

  it('sends the expired email after an expiring one, then never again', () => {
    expect(
      expiryReminderDue(
        upload('2026-10-11', { expiryReminderSentAt: '2026-09-11T08:00:00Z' }),
        TODAY,
      ),
    ).toBe('expired');
    expect(
      expiryReminderDue(
        upload('2026-10-11', { expiryReminderSentAt: '2026-10-12T08:00:00Z' }),
        TODAY,
      ),
    ).toBeNull();
  });

  it('treats a reminder sent before the window as stale after a date change', () => {
    expect(
      expiryReminderDue(
        upload('2026-11-11', { expiryReminderSentAt: '2025-10-01T08:00:00Z' }),
        TODAY,
      ),
    ).toBe('expiring');
  });

  it('includes pending uploads and skips rejected ones', () => {
    expect(
      expiryReminderDue(
        upload('2026-10-20', { reviewStatus: 'pending' }),
        TODAY,
      ),
    ).toBe('expiring');
    expect(
      expiryReminderDue(
        upload('2026-10-20', { reviewStatus: 'rejected' }),
        TODAY,
      ),
    ).toBeNull();
  });
});
