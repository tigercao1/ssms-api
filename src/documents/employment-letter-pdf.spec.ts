import { PDFDocument } from '@cantoo/pdf-lib';
import { pdftotext } from '../../test/helpers/pdf-render';
import {
  EMPLOYMENT_LETTER_PLACEHOLDERS,
  EmploymentLetterTemplateError,
  type EmploymentLetterValues,
  fillEmploymentLetter,
  readEmploymentLetterTemplate,
  renderEmploymentLetter,
} from './employment-letter-pdf';

jest.setTimeout(30_000);

const values: EmploymentLetterValues = {
  legal_name: 'Alice Wang',
  issue_date: 'October 19, 2026',
  season: '2026/27',
  season_start: 'November 1, 2026',
  season_end: 'April 30, 2027',
  email: 'alice@example.com',
};

describe('fillEmploymentLetter', () => {
  it('replaces every placeholder, with or without inner spaces', () => {
    expect(
      fillEmploymentLetter('{{legal_name}} / {{ email }} / {{season}}', values),
    ).toBe('Alice Wang / alice@example.com / 2026/27');
  });

  it('rejects an unknown placeholder', () => {
    expect(() => fillEmploymentLetter('Dear {{display_name}}', values)).toThrow(
      EmploymentLetterTemplateError,
    );
  });

  it('does not treat inherited keys as placeholders', () => {
    expect(() => fillEmploymentLetter('{{constructor}}', values)).toThrow(
      EmploymentLetterTemplateError,
    );
  });
});

describe('the bundled template', () => {
  it('uses only known placeholders and includes the legal name', async () => {
    const template = await readEmploymentLetterTemplate();
    const used = [...template.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)].map(
      (m) => m[1],
    );
    expect(used).toContain('legal_name');
    for (const name of used) {
      expect(EMPLOYMENT_LETTER_PLACEHOLDERS).toContain(name);
    }
    expect(fillEmploymentLetter(template, values)).not.toContain('{{');
  });
});

describe('renderEmploymentLetter', () => {
  it('draws the heading, keeps line breaks and renders Chinese text', async () => {
    const bytes = await renderEmploymentLetter(
      '# Letter title\n\nFirst line\nSecond line\n\n兹证明 Alice Wang 受雇于 SSnow。',
    );
    const text = await pdftotext(bytes);
    expect(text).toContain('Letter title');
    expect(text).toMatch(/First line\s*\nSecond line/);
    expect(text).toContain('兹证明 Alice Wang 受雇于 SSnow。');
    expect(text).not.toContain('# ');
  });

  it('wraps long paragraphs and continues on a new page', async () => {
    const paragraph = 'employment '.repeat(120).trim();
    const bytes = await renderEmploymentLetter(
      Array.from({ length: 8 }, () => paragraph).join('\n\n'),
    );
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(1);
    expect(doc.getTitle()).toBe('Employment letter');
  });
});
