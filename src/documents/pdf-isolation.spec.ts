import {
  activeContentIn,
  annotationHeavyPdf,
  pdfFixture,
} from '../../test/helpers/pdf-fixtures';
import {
  PDF_TASK_LIMITS,
  PdfTooComplexError,
  runPdfTask,
} from './pdf-isolation';
import { TemplatePdfError } from './template-pdf';

jest.setTimeout(60_000);

describe('runPdfTask', () => {
  it('normalises a form PDF in a worker without its annotations, actions, scripts or attachments', async () => {
    const input = await pdfFixture('activeContent');

    const output = await runPdfTask('normaliseForm', input);

    expect(await activeContentIn(input)).toEqual([
      'A',
      'AA',
      'AcroForm',
      'Annots',
      'EF',
      'EmbeddedFiles',
      'FileAttachment',
      'JS',
      'JavaScript',
      'Launch',
      'Names',
      'OpenAction',
      'URI',
    ]);
    expect(output.pageCount).toBe(2);
    expect(await activeContentIn(output.bytes)).toEqual([]);
  });

  it('passes a refused PDF back as the same template problem', async () => {
    await expect(
      runPdfTask('normaliseForm', Buffer.from('hello')),
    ).rejects.toEqual(new TemplatePdfError('invalid'));
  });

  it('stops a job that outgrows its heap cap and keeps the process able to run the next one', async () => {
    const error = await runPdfTask(
      'normaliseForm',
      annotationHeavyPdf(60_000),
    ).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(PdfTooComplexError);
    expect((error as PdfTooComplexError).reason).toBe('memory');
    const next = await runPdfTask('normaliseForm', await pdfFixture('normal'));
    expect(next.pageCount).toBe(2);
  });

  it('stops a job that runs past its deadline', async () => {
    const error = await runPdfTask(
      'normaliseForm',
      await pdfFixture('normal'),
      { ...PDF_TASK_LIMITS, timeoutMs: 1 },
    ).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(PdfTooComplexError);
    expect((error as PdfTooComplexError).reason).toBe('time');
  });
});
