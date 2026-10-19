import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as fontkit from '@cantoo/fontkit';
import { PDFDocument, rgb } from '@cantoo/pdf-lib';
import { loadStampFonts, wrap } from './pdf-stamper';

export const EMPLOYMENT_LETTER_TEMPLATE = join(
  __dirname,
  '..',
  '..',
  'assets',
  'employment-letter',
  'template.txt',
);

export const EMPLOYMENT_LETTER_PLACEHOLDERS = [
  'legal_name',
  'issue_date',
  'season',
  'season_start',
  'season_end',
  'email',
] as const;

export type EmploymentLetterValues = Record<
  (typeof EMPLOYMENT_LETTER_PLACEHOLDERS)[number],
  string
>;

const PAGE: [number, number] = [612, 792];
const MARGIN = 72;
const BODY_SIZE = 11;
const HEADING_SIZE = 16;
const LINE_GAP = 5;
const PARAGRAPH_GAP = 10;
const TEXT_COLOUR = rgb(0.1, 0.1, 0.1);
const PLACEHOLDER = /\{\{\s*([^}]*?)\s*\}\}/g;

export class EmploymentLetterTemplateError extends Error {}

export function readEmploymentLetterTemplate(
  path: string = EMPLOYMENT_LETTER_TEMPLATE,
): Promise<string> {
  return readFile(path, 'utf8');
}

export function fillEmploymentLetter(
  template: string,
  values: EmploymentLetterValues,
): string {
  return template.replace(PLACEHOLDER, (_match, name: string) => {
    if (!Object.hasOwn(values, name)) {
      throw new EmploymentLetterTemplateError(
        `Unknown employment letter placeholder {{${name}}}`,
      );
    }
    return values[name as keyof EmploymentLetterValues];
  });
}

export async function renderEmploymentLetter(
  text: string,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle('Employment letter');
  doc.setProducer('SSnow');
  const font = await doc.embedFont((await loadStampFonts()).text, {
    subset: true,
  });
  const width = PAGE[0] - 2 * MARGIN;
  let page = doc.addPage(PAGE);
  let y = PAGE[1] - MARGIN;
  const line = (value: string, size: number) => {
    if (y - size < MARGIN) {
      page = doc.addPage(PAGE);
      y = PAGE[1] - MARGIN;
    }
    y -= size;
    page.drawText(value, { x: MARGIN, y, size, font, color: TEXT_COLOUR });
    y -= LINE_GAP;
  };
  for (const paragraph of text.replace(/\r\n?/g, '\n').split(/\n\s*\n/)) {
    const trimmed = paragraph.trim();
    if (trimmed === '') {
      continue;
    }
    const heading = trimmed.startsWith('# ');
    const size = heading ? HEADING_SIZE : BODY_SIZE;
    const body = heading ? trimmed.slice(2).trim() : trimmed;
    for (const row of wrap(body, font, size, width)) {
      line(row, size);
    }
    y -= PARAGRAPH_GAP;
  }
  return doc.save({ useObjectStreams: true });
}
