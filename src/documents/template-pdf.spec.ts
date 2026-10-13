import { PDFDocument, PDFName } from '@cantoo/pdf-lib';
import { pdfFixture } from '../../test/helpers/pdf-fixtures';
import {
  normaliseTemplatePdf,
  samePageLayout,
  sha256Hex,
  TemplatePdfError,
} from './template-pdf';

async function problemOf(bytes: Uint8Array): Promise<string> {
  try {
    await normaliseTemplatePdf(bytes);
  } catch (err) {
    expect(err).toBeInstanceOf(TemplatePdfError);
    return (err as TemplatePdfError).problem;
  }
  throw new Error('expected normaliseTemplatePdf to reject');
}

describe('normaliseTemplatePdf', () => {
  it('re-saves a normal PDF and records pages, count and hash', async () => {
    const result = await normaliseTemplatePdf(await pdfFixture('normal'));
    expect(result.pageCount).toBe(2);
    expect(result.pages).toEqual([
      { width: 612, height: 792, rotate: 0, x: 0, y: 0 },
      { width: 612, height: 792, rotate: 0, x: 0, y: 0 },
    ]);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.sha256).toBe(sha256Hex(result.bytes));
    const reopened = await PDFDocument.load(result.bytes);
    expect(reopened.getPageCount()).toBe(2);
  });

  it('removes owner-only encryption', async () => {
    const input = await pdfFixture('ownerEncrypted');
    await expect(PDFDocument.load(input)).rejects.toThrow(/encrypted/);
    const result = await normaliseTemplatePdf(input);
    const reopened = await PDFDocument.load(result.bytes);
    expect(reopened.isEncrypted).toBe(false);
    expect(result.pageCount).toBe(1);
  });

  it('refuses a PDF that needs a user password', async () => {
    expect(await problemOf(await pdfFixture('userPassword'))).toBe(
      'password_protected',
    );
  });

  it('refuses XFA forms', async () => {
    expect(await problemOf(await pdfFixture('xfa'))).toBe('xfa');
  });

  it('refuses bytes that are not a PDF', async () => {
    expect(await problemOf(Buffer.from('not a pdf at all'))).toBe('invalid');
    expect(await problemOf(Buffer.from('%PDF-1.7 garbage'))).toBe('invalid');
  });

  it('flattens an AcroForm into page content', async () => {
    const input = await pdfFixture('acroForm');
    expect((await PDFDocument.load(input)).getForm().getFields()).toHaveLength(
      2,
    );
    const result = await normaliseTemplatePdf(input);
    const reopened = await PDFDocument.load(result.bytes);
    expect(reopened.catalog.has(PDFName.of('AcroForm'))).toBe(false);
    expect(reopened.getForm().getFields()).toHaveLength(0);
    expect(reopened.getPage(0).node.Annots()?.size() ?? 0).toBe(0);
  });

  it('records /Rotate 90 against the unrotated page size', async () => {
    const result = await normaliseTemplatePdf(await pdfFixture('rotated'));
    expect(result.pages).toEqual([
      { width: 612, height: 792, rotate: 90, x: 0, y: 0 },
    ]);
  });

  it('records the CropBox, not the MediaBox, with its offset', async () => {
    const result = await normaliseTemplatePdf(
      await pdfFixture('offsetCropBox'),
    );
    expect(result.pages).toEqual([
      { width: 540, height: 700, rotate: 0, x: 36, y: 48 },
    ]);
    const page = (await PDFDocument.load(result.bytes)).getPage(0);
    expect(page.getMediaBox()).toEqual({ x: 0, y: 0, width: 612, height: 792 });
  });

  it('refuses a PDF without pages', async () => {
    const empty = Buffer.from(
      '%PDF-1.4\n1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n' +
        '2 0 obj\n<</Type/Pages/Kids[]/Count 0>>\nendobj\n' +
        'trailer\n<</Root 1 0 R>>\n%%EOF\n',
    );
    expect(await problemOf(empty)).toBe('no_pages');
  });
});

describe('samePageLayout', () => {
  const page = { width: 612, height: 792, rotate: 0 as const, x: 0, y: 0 };

  it('matches identical layouts, ignoring rotation and float noise', () => {
    expect(
      samePageLayout([page], [{ ...page, rotate: 90, width: 612.001 }]),
    ).toBe(true);
  });

  it('differs on page count, size or offset', () => {
    expect(samePageLayout([page], [page, page])).toBe(false);
    expect(samePageLayout([page], [{ ...page, height: 842 }])).toBe(false);
    expect(samePageLayout([page], [{ ...page, x: 10 }])).toBe(false);
  });
});
