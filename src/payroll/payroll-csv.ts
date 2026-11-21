import {
  ADJUSTED,
  ALREADY_PAID,
  CHANGED_LENGTH,
  CHANGED_LESSON_TYPE,
  CORRECTION,
  LATE,
  LATE_CANCEL,
  REASSIGNED,
} from './payroll-lines';
import type { PayrollPeriodDetail } from './payroll.service';

export const CSV_BOM = '\uFEFF';

export const PAYROLL_SHEET_COLUMNS = [
  'Instructor',
  'Instructor (中文)',
  'Email',
  'Lessons',
  'Hours',
  'Rate unit',
  'Amount',
  'Currency',
];

export const PAYROLL_DETAIL_COLUMNS = [
  'Instructor',
  'Date',
  'Time',
  'Type',
  'Lesson type / description',
  'Customers',
  'Status',
  'Minutes',
  'Rate',
  'Rate unit',
  'Amount',
  'Currency',
  'Flags',
];

type Cell = string | null | { raw: string };

function textCell(value: string | null): string {
  const text = value ?? '';
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

function quote(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function toCsv(header: string[], rows: Cell[][]): string {
  const lines = [header, ...rows].map((row) =>
    row
      .map((cell) =>
        quote(
          cell !== null && typeof cell === 'object' ? cell.raw : textCell(cell),
        ),
      )
      .join(','),
  );
  return `${CSV_BOM}${lines.join('\r\n')}\r\n`;
}

const raw = (value: string) => ({ raw: value });
const money = (value: number) => raw(value.toFixed(2));
const hours = (minutes: number) => raw((minutes / 60).toFixed(2));

function rateUnits(
  detail: PayrollPeriodDetail,
  instructorId: string,
  currency: string,
): string {
  const units = new Set(
    detail.lines
      .filter(
        (line) =>
          line.instructorId === instructorId &&
          line.currency === currency &&
          line.hourlyRate !== null &&
          !line.flags.includes(ALREADY_PAID),
      )
      .map((line) => line.rateUnit),
  );
  return [...units].sort().join('; ');
}

export function payrollSheetCsv(detail: PayrollPeriodDetail): string {
  return toCsv(
    PAYROLL_SHEET_COLUMNS,
    detail.instructors.map((total) => [
      total.instructorName,
      total.instructorNameZh,
      total.email,
      raw(String(total.lessons)),
      hours(total.minutes),
      rateUnits(detail, total.instructorId, total.currency),
      money(total.total),
      total.currency,
    ]),
  );
}

const CHANGE_LABELS: [string, string][] = [
  [CHANGED_LENGTH, 'length'],
  [CHANGED_LESSON_TYPE, 'lesson type'],
];

function lineType(flags: readonly string[]): string {
  const changed = CHANGE_LABELS.filter(([flag]) => flags.includes(flag)).map(
    ([, label]) => label,
  );
  const base = flags.includes(LATE_CANCEL)
    ? 'late cancel'
    : flags.includes(LATE)
      ? 'late lesson'
      : flags.includes(ADJUSTED)
        ? 'adjusted lesson'
        : 'lesson';
  return [
    base,
    ...(flags.includes(CORRECTION) ? ['correction'] : []),
    ...(flags.includes(REASSIGNED) ? ['(reassigned)'] : []),
    ...(changed.length > 0 ? [`(${changed.join('; ')})`] : []),
  ].join(' ');
}

export function payrollDetailCsv(detail: PayrollPeriodDetail): string {
  const rows: Cell[][] = detail.lines.map((line) => [
    line.instructorName,
    line.date,
    line.time,
    lineType(line.flags),
    line.description,
    line.customerNames.join('; '),
    line.classStatus,
    raw(String(line.minutes)),
    line.hourlyRate === null ? '' : money(line.hourlyRate),
    line.hourlyRate === null ? '' : line.rateUnit,
    money(line.amount),
    line.currency,
    line.flags.join('; '),
  ]);
  for (const adjustment of detail.adjustments) {
    rows.push([
      adjustment.instructorName,
      '',
      '',
      'adjustment',
      adjustment.description,
      '',
      '',
      '',
      '',
      '',
      money(adjustment.amount),
      adjustment.currency,
      '',
    ]);
  }
  return toCsv(PAYROLL_DETAIL_COLUMNS, rows);
}
