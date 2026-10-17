import { torontoToday } from './certification-validity';
import type { TemplateAssignmentDbRow } from './document-exports.types';

const UNSAFE_PATH_CHARS = /[\p{Cc}/\\:*?"<>|]+/gu;
const MAX_SEGMENT_LENGTH = 120;
const CSV_FORMULA_START = /^[=+\-@]/;
const CSV_NEEDS_QUOTES = /[",\r\n]/;

export const MANIFEST_NAME = 'manifest.csv';
export const MANIFEST_HEADER = [
  'instructor name',
  'email',
  'signer name',
  'signed at',
  'season',
  'assignment id',
  'sha256',
  'file name',
  'note',
];

/** Why a signed copy is left out of the ZIP. */
export type SkipReason = 'missing' | 'too large';

function clean(value: string | null | undefined): string {
  return (value ?? '')
    .replace(UNSAFE_PATH_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Makes `value` safe as one path segment in a ZIP on Windows, macOS and Linux. */
export function sanitizeSegment(value: string, fallback: string): string {
  const cleaned = clean(value)
    .slice(0, MAX_SEGMENT_LENGTH)
    .replace(/[\s.]+$/, '');
  return cleaned || fallback;
}

/** `<Template title> (<season>)`, or just the title without a season. */
export function exportFolderName(title: string, season: string | null): string {
  return sanitizeSegment(
    season ? `${title} (${season})` : title,
    'Signed documents',
  );
}

function personName(row: TemplateAssignmentDbRow): string {
  const last = clean(row.last_name);
  const first = clean(row.first_name);
  if (last && first) {
    return `${last}, ${first}`;
  }
  return last || first || clean(row.signer_name) || clean(row.email) || row.id;
}

/** `<Last>, <First> - <YYYY-MM-DD>` (Toronto date of signing), without extension. */
export function signedCopyBaseName(row: TemplateAssignmentDbRow): string {
  const date = row.completed_at ? torontoToday(new Date(row.completed_at)) : '';
  const name = date ? `${personName(row)} - ${date}` : personName(row);
  return sanitizeSegment(name, row.id);
}

/** Hands out file names in one folder, suffixing ` (2)`, ` (3)`… on case-insensitive collisions. */
export class UniqueNames {
  private readonly taken = new Set<string>();

  take(base: string, extension: string): string {
    for (let n = 1; ; n += 1) {
      const name =
        n === 1 ? `${base}${extension}` : `${base} (${n})${extension}`;
      const key = name.toLowerCase();
      if (!this.taken.has(key)) {
        this.taken.add(key);
        return name;
      }
    }
  }
}

/** One CSV cell; formula-like values get a leading `'` so spreadsheets show them as text. */
export function csvCell(value: string | null | undefined): string {
  let text = value ?? '';
  if (CSV_FORMULA_START.test(text)) {
    text = `'${text}`;
  }
  return CSV_NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One CSV line ending in CRLF. */
export function csvLine(cells: (string | null | undefined)[]): string {
  return `${cells.map(csvCell).join(',')}\r\n`;
}

/** The manifest line for one assignment; `fileName` is null when the copy was skipped. */
export function manifestLine(
  row: TemplateAssignmentDbRow,
  fileName: string | null,
  skipped: SkipReason | null,
): string {
  const name = [row.first_name, row.last_name]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(' ');
  return csvLine([
    name,
    row.email,
    row.signer_name,
    row.completed_at ? new Date(row.completed_at).toISOString() : null,
    row.season,
    row.id,
    row.signed_sha256,
    fileName,
    skipped ? `skipped: ${skipped}` : null,
  ]);
}

function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '');
}

/** `<slug>-<season>-signed.zip` (season omitted when there is none). */
export function exportDownloadName(
  title: string,
  season: string | null,
): string {
  const parts = [slugify(title) || 'documents'];
  const seasonSlug = season ? slugify(season) : '';
  if (seasonSlug) {
    parts.push(seasonSlug);
  }
  return `${parts.join('-')}-signed.zip`;
}
