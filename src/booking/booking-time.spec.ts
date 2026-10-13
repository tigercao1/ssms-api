import { addDays, localParts, weekdayOf, zonedInstant } from './booking-time';

describe('booking time in America/Toronto', () => {
  it.each([
    ['2026-12-12', '08:00', '2026-12-12T13:00:00.000Z'],
    ['2026-07-04', '08:00', '2026-07-04T12:00:00.000Z'],
    ['2026-03-08', '01:30', '2026-03-08T06:30:00.000Z'],
    ['2026-03-08', '03:00', '2026-03-08T07:00:00.000Z'],
    ['2026-11-01', '00:30', '2026-11-01T04:30:00.000Z'],
    ['2026-11-01', '12:00', '2026-11-01T17:00:00.000Z'],
    ['2025-12-31', '23:45', '2026-01-01T04:45:00.000Z'],
  ])('%s %s local is %s', (date, time, iso) => {
    expect(zonedInstant(date, time).toISOString()).toBe(iso);
  });

  it('reads local date, time and weekday', () => {
    expect(localParts('2026-01-01T03:15:00Z')).toEqual({
      date: '2025-12-31',
      time: '22:15',
      weekday: 'wed',
    });
    expect(localParts('2026-07-05T16:00:00Z')).toEqual({
      date: '2026-07-05',
      time: '12:00',
      weekday: 'sun',
    });
  });

  it('adds calendar days and names weekdays', () => {
    expect(addDays('2026-02-26', 7)).toBe('2026-03-05');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(weekdayOf('2026-12-14')).toBe('mon');
    expect(weekdayOf('2026-12-12')).toBe('sat');
  });
});
