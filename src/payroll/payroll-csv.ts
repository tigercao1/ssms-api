import type { PayrollPeriodDetail } from './payroll.service';

export const CSV_BOM = '\uFEFF';

export const PAYROLL_SHEET_COLUMNS = [
  'Instructor',
  'Instructor (中文)',
  'Email',
  'Lessons',
  'Hours',
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

export function payrollSheetCsv(detail: PayrollPeriodDetail): string {
  return toCsv(
    PAYROLL_SHEET_COLUMNS,
    detail.instructors.map((total) => [
      total.instructorName,
      total.instructorNameZh,
      total.email,
      raw(String(total.lessons)),
      hours(total.minutes),
      money(total.total),
      total.currency,
    ]),
  );
}

export function payrollDetailCsv(detail: PayrollPeriodDetail): string {
  const rows: Cell[][] = detail.lines.map((line) => [
    line.instructorName,
    line.date,
    line.time,
    'lesson',
    line.description,
    line.customerNames.join('; '),
    line.classStatus,
    raw(String(line.minutes)),
    line.hourlyRate === null ? '' : money(line.hourlyRate),
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
      money(adjustment.amount),
      adjustment.currency,
      '',
    ]);
  }
  return toCsv(PAYROLL_DETAIL_COLUMNS, rows);
}
