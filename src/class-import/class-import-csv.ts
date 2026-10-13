import {
  PairingCsvError,
  parseCsv,
} from '../shopify/legacy-pairing/pairing-csv';

export const IMPORT_COLUMNS = {
  id: 'id',
  eventName: 'event.name',
  firstName: 'firstName',
  lastName: 'lastName',
  email: 'contactEmail',
  phone: 'contactPhone',
  instructor: 'availability',
  startDate: 'date.startDate',
  endDate: 'date.endDate',
  status: 'status',
} as const;

export const REQUIRED_COLUMNS = [
  IMPORT_COLUMNS.id,
  IMPORT_COLUMNS.eventName,
  IMPORT_COLUMNS.instructor,
  IMPORT_COLUMNS.startDate,
  IMPORT_COLUMNS.endDate,
  IMPORT_COLUMNS.status,
];

export const MAX_IMPORT_ROWS = 5000;
const MAX_EXTERNAL_ID_LENGTH = 200;

export class ClassImportCsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClassImportCsvError';
  }
}

export interface ParsedImportRow {
  rowNo: number;
  externalId: string;
  raw: Record<string, string>;
}

export interface ImportRowFields {
  eventName: string | null;
  instructorName: string | null;
  customerName: string | null;
  email: string | null;
  phone: string | null;
  startsAt: string | null;
  endsAt: string | null;
  deleted: boolean;
  valid: boolean;
}

function cell(raw: Record<string, unknown>, column: string): string {
  const value = raw[column];
  return typeof value === 'string' ? value.trim() : '';
}

function orNull(value: string): string | null {
  return value === '' ? null : value;
}

function isoOrNull(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

export function placeholderExternalId(rowNo: number): string {
  return `row-${rowNo}`;
}

export function parseImportCsv(text: string): ParsedImportRow[] {
  let table: string[][];
  try {
    table = parseCsv(text);
  } catch (err) {
    if (err instanceof PairingCsvError) {
      throw new ClassImportCsvError('The CSV has an unterminated quoted field');
    }
    throw err;
  }
  const [header, ...body] = table;
  if (!header) {
    throw new ClassImportCsvError('The CSV is empty');
  }
  const columns = header.map((h) => h.trim());
  const missing = REQUIRED_COLUMNS.filter((c) => !columns.includes(c));
  if (missing.length > 0) {
    throw new ClassImportCsvError(
      `The CSV is missing columns: ${missing.join(', ')}`,
    );
  }
  if (body.length === 0) {
    throw new ClassImportCsvError('The CSV has no rows');
  }
  if (body.length > MAX_IMPORT_ROWS) {
    throw new ClassImportCsvError(
      `The CSV has more than ${MAX_IMPORT_ROWS} rows`,
    );
  }
  return body.map((cells, index) => {
    const rowNo = index + 1;
    const raw: Record<string, string> = {};
    columns.forEach((column, i) => {
      if (column !== '') {
        raw[column] = cells[i] ?? '';
      }
    });
    const id = cell(raw, IMPORT_COLUMNS.id);
    const externalId =
      id !== '' && id.length <= MAX_EXTERNAL_ID_LENGTH
        ? id
        : placeholderExternalId(rowNo);
    return { rowNo, externalId, raw };
  });
}

export function rowFields(raw: Record<string, unknown>): ImportRowFields {
  const id = cell(raw, IMPORT_COLUMNS.id);
  const startsAt = isoOrNull(cell(raw, IMPORT_COLUMNS.startDate));
  const endsAt = isoOrNull(cell(raw, IMPORT_COLUMNS.endDate));
  const name = [
    cell(raw, IMPORT_COLUMNS.firstName),
    cell(raw, IMPORT_COLUMNS.lastName),
  ]
    .filter((part) => part !== '')
    .join(' ');
  return {
    eventName: orNull(cell(raw, IMPORT_COLUMNS.eventName)),
    instructorName: orNull(cell(raw, IMPORT_COLUMNS.instructor)),
    customerName: orNull(name),
    email: orNull(cell(raw, IMPORT_COLUMNS.email)),
    phone: orNull(cell(raw, IMPORT_COLUMNS.phone)),
    startsAt,
    endsAt,
    deleted: cell(raw, IMPORT_COLUMNS.status).toLowerCase() === 'deleted',
    valid:
      id !== '' &&
      id.length <= MAX_EXTERNAL_ID_LENGTH &&
      startsAt !== null &&
      endsAt !== null &&
      Date.parse(endsAt) > Date.parse(startsAt),
  };
}
