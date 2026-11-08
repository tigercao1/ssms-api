import { localParts } from '../booking/booking-time';
import type { AdminClass, AdminClassParticipant } from './classes.service';

export const CSV_BOM = '\uFEFF';

export const CLASS_EXPORT_COLUMNS = [
  'Class ID',
  'Date',
  'Start',
  'End',
  'Instructor',
  'Lesson type',
  'Location',
  'Status',
  'Customers',
  'Notes',
  'Created at',
];

function textCell(value: string | null): string {
  const text = value ?? '';
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

function quote(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function nonBlank(parts: (string | null)[]): string[] {
  return parts.map((part) => part?.trim() ?? '').filter((part) => part !== '');
}

function firstNonBlank(parts: (string | null)[]): string {
  return nonBlank(parts)[0] ?? '';
}

function customerText(participant: AdminClassParticipant): string {
  const name = nonBlank([participant.firstName, participant.lastName]).join(
    ' ',
  );
  return nonBlank([name, participant.email, participant.phone]).join('; ');
}

function localDateTime(instant: string): string {
  const { date, time } = localParts(instant);
  return `${date} ${time}`;
}

export function classExportCells(row: AdminClass): string[] {
  const start = localParts(row.startsAt);
  return [
    row.id,
    start.date,
    start.time,
    localParts(row.endsAt).time,
    firstNonBlank([row.instructorName, row.instructorNameZh]),
    firstNonBlank([row.lessonTypeNameEn, row.lessonTypeNameZh]),
    row.locationName ?? '',
    row.status,
    row.participants.map(customerText).join(' | '),
    row.notes ?? '',
    localDateTime(row.createdAt),
  ];
}

export function classesCsv(rows: AdminClass[]): string {
  const lines = [CLASS_EXPORT_COLUMNS, ...rows.map(classExportCells)].map(
    (cells) => cells.map((cell) => quote(textCell(cell))).join(','),
  );
  return `${CSV_BOM}${lines.join('\r\n')}\r\n`;
}
