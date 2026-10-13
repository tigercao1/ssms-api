import {
  addDays,
  daysBetween,
  localDate,
  localTime,
  periodContaining,
  periodsAround,
  startOfLocalDay,
} from './payroll-time';

describe('payroll time helpers', () => {
  it('finds Toronto midnight in winter, summer and on both DST change days', () => {
    expect(startOfLocalDay('2026-01-05')).toBe('2026-01-05T05:00:00.000Z');
    expect(startOfLocalDay('2026-07-01')).toBe('2026-07-01T04:00:00.000Z');
    expect(startOfLocalDay('2026-03-08')).toBe('2026-03-08T05:00:00.000Z');
    expect(startOfLocalDay('2026-03-09')).toBe('2026-03-09T04:00:00.000Z');
    expect(startOfLocalDay('2026-11-01')).toBe('2026-11-01T04:00:00.000Z');
    expect(startOfLocalDay('2026-11-02')).toBe('2026-11-02T05:00:00.000Z');
  });

  it('formats instants as Toronto wall-clock dates and times', () => {
    expect(localDate('2026-01-12T04:59:00Z')).toBe('2026-01-11');
    expect(localTime('2026-01-12T04:59:00Z')).toBe('23:59');
    expect(localTime('2026-11-01T06:30:00Z')).toBe('01:30');
  });

  it('does calendar arithmetic across month, year and leap days', () => {
    expect(addDays('2025-12-28', 4)).toBe('2026-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(daysBetween('2025-12-15', '2026-03-09')).toBe(84);
    expect(daysBetween('2025-12-15', '2025-12-01')).toBe(-14);
  });

  it('places any date in exactly one 14-day period, before or after the anchor', () => {
    expect(periodContaining('2025-12-15', '2025-12-15')).toEqual({
      startsOn: '2025-12-15',
      endsOn: '2025-12-28',
    });
    expect(periodContaining('2025-12-15', '2025-12-28').startsOn).toBe(
      '2025-12-15',
    );
    expect(periodContaining('2025-12-15', '2025-12-14')).toEqual({
      startsOn: '2025-12-01',
      endsOn: '2025-12-14',
    });
    expect(
      periodsAround('2025-12-15', '2026-01-07', 1, 1).map((p) => p.startsOn),
    ).toEqual(['2025-12-15', '2025-12-29', '2026-01-12']);
  });
});
