import { currentSeasonOn, seasonContaining } from './current-season';

const S2025 = {
  key: '2025/26',
  starts_on: '2025-11-01',
  ends_on: '2026-04-30',
};
const S2026 = {
  key: '2026/27',
  starts_on: '2026-11-01',
  ends_on: '2027-04-30',
};
const S2027 = {
  key: '2027/28',
  starts_on: '2027-11-01',
  ends_on: '2028-04-30',
};
const ALL = [S2027, S2025, S2026];

describe('seasonContaining', () => {
  it('includes both ends of the range', () => {
    expect(seasonContaining(ALL, '2026-11-01')).toBe(S2026);
    expect(seasonContaining(ALL, '2027-04-30')).toBe(S2026);
    expect(seasonContaining(ALL, '2027-05-01')).toBeNull();
  });
});

describe('currentSeasonOn', () => {
  it('is the season containing today', () => {
    expect(currentSeasonOn(ALL, '2027-01-15')).toBe(S2026);
  });

  it('is the next season to start between seasons, so 2026-10-15 is 2026/27', () => {
    expect(currentSeasonOn(ALL, '2026-10-15')).toBe(S2026);
    expect(currentSeasonOn(ALL, '2027-06-01')).toBe(S2027);
  });

  it('is the latest season after every season ended, and null with none', () => {
    expect(currentSeasonOn(ALL, '2030-01-01')).toBe(S2027);
    expect(currentSeasonOn([], '2026-10-15')).toBeNull();
  });
});
