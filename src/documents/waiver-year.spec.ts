import {
  signedThisWaiverYear,
  waiverFor,
  waiverYearKey,
  waiverYearStart,
} from './waiver-year';

describe('waiver year', () => {
  it.each([
    ['2026-07-01T03:59:59.999Z', 2025, '2025/26'],
    ['2026-07-01T04:00:00.000Z', 2026, '2026/27'],
    ['2026-11-09T15:00:00.000Z', 2026, '2026/27'],
    ['2027-01-01T04:59:59.000Z', 2026, '2026/27'],
    ['2027-06-30T23:59:59.000Z', 2026, '2026/27'],
    ['2027-07-01T03:59:59.000Z', 2026, '2026/27'],
    ['2027-07-01T04:00:00.000Z', 2027, '2027/28'],
    ['2099-12-31T12:00:00.000Z', 2099, '2099/00'],
  ])('puts %s in the waiver year starting July %i (%s)', (at, start, key) => {
    expect(waiverYearStart(new Date(at))).toBe(start);
    expect(waiverYearKey(new Date(at))).toBe(key);
  });

  it('reads July 1 in Toronto, not UTC: 23:59 on June 30 Toronto is still the old year', () => {
    expect(waiverYearKey(new Date('2026-06-30T23:59:00-04:00'))).toBe(
      '2025/26',
    );
    expect(waiverYearKey(new Date('2026-07-01T00:00:00-04:00'))).toBe(
      '2026/27',
    );
  });

  it('is unaffected by the DST changes in March and November', () => {
    for (const at of [
      '2026-03-08T06:59:00Z',
      '2026-03-08T07:00:00Z',
      '2026-11-01T05:59:00Z',
      '2026-11-01T06:00:00Z',
    ]) {
      expect(waiverYearKey(new Date(at))).toBe(
        at.startsWith('2026-03') ? '2025/26' : '2026/27',
      );
    }
  });

  describe('waiverFor', () => {
    const now = new Date('2026-11-09T15:00:00.000Z');

    it('is signed with a signature made this waiver year', () => {
      expect(waiverFor('2026-07-01T04:00:00.000Z', now)).toEqual({
        status: 'signed',
        signedAt: '2026-07-01T04:00:00.000Z',
        year: '2026/27',
      });
    });

    it('is expired with a signature from an earlier waiver year', () => {
      expect(waiverFor('2026-07-01T03:59:00.000Z', now)).toEqual({
        status: 'expired',
        signedAt: '2026-07-01T03:59:00.000Z',
        year: '2026/27',
      });
    });

    it('is none without a signature', () => {
      expect(waiverFor(null, now)).toEqual({
        status: 'none',
        signedAt: null,
        year: '2026/27',
      });
    });

    it('expires a signature on the next July 1 in Toronto', () => {
      const signed = '2026-11-01T12:00:00.000Z';
      expect(
        signedThisWaiverYear(signed, new Date('2027-07-01T03:59:00.000Z')),
      ).toBe(true);
      expect(
        signedThisWaiverYear(signed, new Date('2027-07-01T04:00:00.000Z')),
      ).toBe(false);
    });
  });
});
