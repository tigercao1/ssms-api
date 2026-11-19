export type IcsMethod = 'REQUEST' | 'CANCEL';

export interface IcsPerson {
  email: string;
  name?: string | null;
}

export interface IcsEvent {
  method: IcsMethod;
  uid: string;
  sequence: number;
  stamp: Date;
  start: Date;
  end: Date;
  summary: string;
  description?: string | null;
  location?: string | null;
  organizer: IcsPerson;
  attendees: IcsPerson[];
}

export const ICS_CONTENT_TYPE = 'text/calendar';
export const ICS_UID_DOMAIN = 'ssnow.club';
const PRODID = '-//Serendipity Snow Club//SSMS Booking//EN';
const MAX_LINE_OCTETS = 75;

export function classUid(classId: string): string {
  return `class-${classId}@${ICS_UID_DOMAIN}`;
}

export function icsContentType(method: IcsMethod): string {
  return `${ICS_CONTENT_TYPE}; charset=utf-8; method=${method}`;
}

export function buildIcs(event: IcsEvent): string {
  const lines = [
    'BEGIN:VCALENDAR',
    `PRODID:${PRODID}`,
    'VERSION:2.0',
    'CALSCALE:GREGORIAN',
    `METHOD:${event.method}`,
    'BEGIN:VEVENT',
    `UID:${escapeText(event.uid)}`,
    `SEQUENCE:${Math.max(0, Math.trunc(event.sequence))}`,
    `DTSTAMP:${utc(event.stamp)}`,
    `DTSTART:${utc(event.start)}`,
    `DTEND:${utc(event.end)}`,
    `SUMMARY:${escapeText(event.summary)}`,
    ...(event.description
      ? [`DESCRIPTION:${escapeText(event.description)}`]
      : []),
    ...(event.location ? [`LOCATION:${escapeText(event.location)}`] : []),
    `STATUS:${event.method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'}`,
    'TRANSP:OPAQUE',
    `ORGANIZER${nameParam(event.organizer)}:mailto:${event.organizer.email}`,
    ...event.attendees.map(
      (a) =>
        `ATTENDEE${nameParam(a)};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=FALSE:mailto:${a.email}`,
    ),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

export function utc(date: Date): string {
  return date
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[-:]/g, '');
}

export function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

function nameParam(person: IcsPerson): string {
  const name = person.name?.replace(/["\r\n]/g, '').trim();
  return name ? `;CN="${name}"` : '';
}

export function fold(line: string): string {
  const parts: string[] = [];
  let current = '';
  let octets = 0;
  for (const char of line) {
    const size = Buffer.byteLength(char, 'utf8');
    const limit = parts.length === 0 ? MAX_LINE_OCTETS : MAX_LINE_OCTETS - 1;
    if (octets + size > limit) {
      parts.push(current);
      current = '';
      octets = 0;
    }
    current += char;
    octets += size;
  }
  parts.push(current);
  return parts.join('\r\n ');
}
