import type { PairProposal } from './name-matching';

export const PAIRING_CSV_COLUMNS = [
  'instructor_id',
  'ssms_name_en',
  'ssms_name_zh',
  'legacy_handle',
  'legacy_name',
  'score',
  'confirm',
] as const;

export type PairingCsvRow = Record<
  (typeof PAIRING_CSV_COLUMNS)[number],
  string
>;

export interface ConfirmedPair {
  line: number;
  instructorId: string;
  legacyHandle: string;
}

export class PairingCsvError extends Error {
  constructor(readonly problems: string[]) {
    super(`Pairing CSV is invalid:\n  - ${problems.join('\n  - ')}`);
    this.name = 'PairingCsvError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function formatPairingCsv(rows: PairProposal[]): string {
  const lines = [PAIRING_CSV_COLUMNS.join(',')];
  for (const row of rows) {
    lines.push(
      [
        row.instructorId,
        row.ssmsNameEn,
        row.ssmsNameZh,
        row.legacyHandle,
        row.legacyName,
        row.legacyHandle ? row.score.toFixed(2) : '',
        '',
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const source = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') {
        i++;
      }
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (quoted) {
    throw new PairingCsvError(['unterminated quoted field']);
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

export function parsePairingCsv(text: string): ConfirmedPair[] {
  const [header, ...body] = parseCsv(text);
  if (!header) {
    throw new PairingCsvError(['file is empty']);
  }
  const names = header.map((h) => h.trim().toLowerCase());
  const missing = PAIRING_CSV_COLUMNS.filter((c) => !names.includes(c));
  if (missing.length > 0) {
    throw new PairingCsvError([`missing column(s): ${missing.join(', ')}`]);
  }
  const at = (cells: string[], column: string) =>
    (cells[names.indexOf(column)] ?? '').trim();

  const problems: string[] = [];
  const confirmed: ConfirmedPair[] = [];
  body.forEach((cells, index) => {
    const line = index + 2;
    const confirm = at(cells, 'confirm').toLowerCase();
    if (confirm === '' || confirm === 'n') {
      return;
    }
    if (confirm !== 'y') {
      problems.push(
        `line ${line}: confirm must be y, n or empty (got "${confirm}")`,
      );
      return;
    }
    const instructorId = at(cells, 'instructor_id');
    const legacyHandle = at(cells, 'legacy_handle');
    if (!UUID.test(instructorId)) {
      problems.push(
        `line ${line}: instructor_id "${instructorId}" is not a uuid`,
      );
    }
    if (legacyHandle === '') {
      problems.push(`line ${line}: confirmed row has no legacy_handle`);
    }
    confirmed.push({ line, instructorId, legacyHandle });
  });

  const byHandle = new Map<string, number[]>();
  const byInstructor = new Map<string, number[]>();
  for (const pair of confirmed) {
    if (pair.legacyHandle !== '') {
      byHandle.set(pair.legacyHandle, [
        ...(byHandle.get(pair.legacyHandle) ?? []),
        pair.line,
      ]);
    }
    byInstructor.set(pair.instructorId, [
      ...(byInstructor.get(pair.instructorId) ?? []),
      pair.line,
    ]);
  }
  for (const [handle, lines] of byHandle) {
    if (lines.length > 1) {
      problems.push(
        `legacy_handle "${handle}" is confirmed more than once (lines ${lines.join(', ')})`,
      );
    }
  }
  for (const [id, lines] of byInstructor) {
    if (lines.length > 1) {
      problems.push(
        `instructor_id ${id} is confirmed more than once (lines ${lines.join(', ')})`,
      );
    }
  }
  if (problems.length > 0) {
    throw new PairingCsvError(problems);
  }
  return confirmed;
}
