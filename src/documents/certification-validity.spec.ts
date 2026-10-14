import {
  certificationKey,
  certificationState,
  currentUploads,
  daysBetween,
  isCertificationSatisfied,
  utcToday,
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

describe('utcToday', () => {
  it('formats the UTC date', () => {
    expect(utcToday(new Date('2026-10-13T02:30:00Z'))).toBe('2026-10-13');
    expect(utcToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
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
