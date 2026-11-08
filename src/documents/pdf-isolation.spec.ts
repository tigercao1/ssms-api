import childProcess, { execFileSync } from 'node:child_process';
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

  it('caps the worker heap, young generation included, below the deployed parent heap', async () => {
    const fork = jest.spyOn(childProcess, 'fork');
    await runPdfTask('normaliseForm', await pdfFixture('normal'));
    const execArgv = fork.mock.calls[0][2]!.execArgv!.filter((arg) =>
      arg.startsWith('--max-'),
    );
    fork.mockRestore();

    const limitMb = Number(
      execFileSync(
        process.execPath,
        [
          ...execArgv,
          '-p',
          'require("v8").getHeapStatistics().heap_size_limit / 1048576',
        ],
        {
          env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=320' },
        },
      ).toString(),
    );

    expect(limitMb).toBeLessThanOrEqual(PDF_TASK_LIMITS.maxOldSpaceSizeMb + 64);
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
