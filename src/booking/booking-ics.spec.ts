import {
  buildIcs,
  classUid,
  escapeText,
  fold,
  type IcsCalendar,
  icsContentType,
  type IcsEvent,
  utc,
} from './booking-ics';

const CLASS_ID = 'c0000000-0000-4000-8000-000000000001';

const CLASS_B = 'c0000000-0000-4000-8000-000000000002';

const event = (overrides: Partial<IcsEvent> = {}): IcsEvent => ({
  uid: classUid(CLASS_ID),
  sequence: 0,
  start: new Date('2026-12-12T15:00:00.000Z'),
  end: new Date('2026-12-12T16:00:00.000Z'),
  summary: 'Private 1h with Amy',
  location: 'Blue Mountain',
  attendees: [
    { email: 'mei@example.com', name: 'Mei Wang' },
    { email: 'amy@example.com', name: 'Amy' },
  ],
  ...overrides,
});

const calendar = (
  overrides: Partial<IcsEvent> = {},
  calendarOverrides: Partial<IcsCalendar> = {},
): IcsCalendar => ({
  method: 'REQUEST',
  stamp: new Date('2026-12-10T17:00:00.000Z'),
  organizer: { email: 'noreply@contact.ssnow.club', name: 'Serendipity Snow' },
  events: [event(overrides)],
  ...calendarOverrides,
});

const lines = (ics: string) => ics.replace(/\r\n /g, '').split('\r\n');

describe('buildIcs', () => {
  it('writes a REQUEST with UTC times, organizer and attendees', () => {
    const ics = buildIcs(calendar());
    expect(ics.endsWith('\r\n')).toBe(true);
    expect(ics).not.toMatch(/[^\r]\n/);
    expect(lines(ics)).toEqual([
      'BEGIN:VCALENDAR',
      'PRODID:-//Serendipity Snow Club//SSMS Booking//EN',
      'VERSION:2.0',
      'CALSCALE:GREGORIAN',
      'METHOD:REQUEST',
      'BEGIN:VEVENT',
      `UID:class-${CLASS_ID}@ssnow.club`,
      'SEQUENCE:0',
      'DTSTAMP:20261210T170000Z',
      'DTSTART:20261212T150000Z',
      'DTEND:20261212T160000Z',
      'SUMMARY:Private 1h with Amy',
      'LOCATION:Blue Mountain',
      'STATUS:CONFIRMED',
      'TRANSP:OPAQUE',
      'ORGANIZER;CN="Serendipity Snow":mailto:noreply@contact.ssnow.club',
      'ATTENDEE;CN="Mei Wang";ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=FALSE:mailto:mei@example.com',
      'ATTENDEE;CN="Amy";ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=FALSE:mailto:amy@example.com',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ]);
  });

  it('writes an attendee marked as accepted without asking for a reply', () => {
    const ics = lines(
      buildIcs(
        calendar({
          attendees: [
            { email: 'mei@example.com', name: 'Mei Wang' },
            { email: 'amy@example.com', name: 'Amy', partstat: 'ACCEPTED' },
          ],
        }),
      ),
    );
    expect(ics.filter((l) => l.startsWith('ATTENDEE'))).toEqual([
      'ATTENDEE;CN="Mei Wang";ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=FALSE:mailto:mei@example.com',
      'ATTENDEE;CN="Amy";ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=FALSE:mailto:amy@example.com',
    ]);
  });

  it('writes a CANCEL with the same UID and a higher SEQUENCE', () => {
    const ics = lines(
      buildIcs(calendar({ sequence: 3 }, { method: 'CANCEL' })),
    );
    expect(ics).toContain('METHOD:CANCEL');
    expect(ics).toContain('STATUS:CANCELLED');
    expect(ics).toContain('SEQUENCE:3');
    expect(ics).toContain(`UID:class-${CLASS_ID}@ssnow.club`);
  });

  it('omits empty optional fields and names', () => {
    const ics = lines(
      buildIcs(
        calendar(
          {
            location: null,
            attendees: [{ email: 'leo@example.com', name: '  ' }],
          },
          { organizer: { email: 'info@ssnow.club' } },
        ),
      ),
    );
    expect(ics.some((l) => l.startsWith('LOCATION'))).toBe(false);
    expect(ics).toContain('ORGANIZER:mailto:info@ssnow.club');
    expect(ics).toContain(
      'ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=FALSE:mailto:leo@example.com',
    );
  });

  it('escapes text values and strips quotes from names', () => {
    const ics = lines(
      buildIcs(
        calendar({
          summary: 'Group; kids, level 1\\2',
          attendees: [{ email: 'a@example.com', name: 'A "Ace" B' }],
        }),
      ),
    );
    expect(ics).toContain('SUMMARY:Group\\; kids\\, level 1\\\\2');
    expect(ics.find((l) => l.startsWith('ATTENDEE'))).toContain('CN="A Ace B"');
  });

  it('writes one VCALENDAR with one VEVENT per lesson, each with its own UID and SEQUENCE', () => {
    const ics = lines(
      buildIcs(
        calendar(
          {},
          {
            events: [
              event(),
              event({
                uid: classUid(CLASS_B),
                sequence: 2,
                start: new Date('2026-12-19T15:00:00.000Z'),
                end: new Date('2026-12-19T16:00:00.000Z'),
              }),
            ],
          },
        ),
      ),
    );
    expect(ics.filter((l) => l === 'BEGIN:VCALENDAR')).toHaveLength(1);
    expect(ics.filter((l) => l.startsWith('METHOD:'))).toEqual([
      'METHOD:REQUEST',
    ]);
    expect(ics.filter((l) => l === 'BEGIN:VEVENT')).toHaveLength(2);
    expect(ics.filter((l) => /^(UID|SEQUENCE|DTSTART):/.test(l))).toEqual([
      `UID:class-${CLASS_ID}@ssnow.club`,
      'SEQUENCE:0',
      'DTSTART:20261212T150000Z',
      `UID:class-${CLASS_B}@ssnow.club`,
      'SEQUENCE:2',
      'DTSTART:20261219T150000Z',
    ]);
  });

  it('folds long lines at 75 octets without splitting characters', () => {
    const long = `SUMMARY:${'滑雪课'.repeat(20)}`;
    const folded = fold(long);
    const parts = folded.split('\r\n');
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(Buffer.byteLength(part, 'utf8')).toBeLessThanOrEqual(75);
    }
    expect(parts.slice(1).every((p) => p.startsWith(' '))).toBe(true);
    expect(folded.replace(/\r\n /g, '')).toBe(long);
  });

  it('formats dates in UTC basic format', () => {
    expect(utc(new Date('2026-03-08T07:05:09.123Z'))).toBe('20260308T070509Z');
  });

  it('escapes CRLF and bare CR as \\n', () => {
    expect(escapeText('a\r\nb\rc')).toBe('a\\nb\\nc');
  });

  it('names the method in the content type', () => {
    expect(icsContentType('CANCEL')).toBe(
      'text/calendar; charset=utf-8; method=CANCEL',
    );
  });
});
