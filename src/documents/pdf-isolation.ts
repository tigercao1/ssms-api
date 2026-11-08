import { fork } from 'node:child_process';
import { extname, join } from 'node:path';
import type { FormStampInput } from './form-pdf';
import type { StampedPdf } from './pdf-stamper';
import {
  type NormalisedTemplatePdf,
  TemplatePdfError,
  type TemplatePdfProblem,
} from './template-pdf';

export interface PdfTasks {
  normaliseForm: { input: Uint8Array; output: NormalisedTemplatePdf };
  stampForm: { input: FormStampInput; output: StampedPdf };
}

export type PdfTaskKind = keyof PdfTasks;

export type PdfTaskReply<K extends PdfTaskKind = PdfTaskKind> =
  | { ok: true; output: PdfTasks[K]['output'] }
  | { ok: false; problem: TemplatePdfProblem | null; message: string };

export interface PdfTaskLimits {
  maxOldSpaceSizeMb: number;
  timeoutMs: number;
}

export const PDF_TASK_LIMITS: PdfTaskLimits = {
  maxOldSpaceSizeMb: 128,
  timeoutMs: 30_000,
};

export class PdfTooComplexError extends Error {
  constructor(readonly reason: 'memory' | 'time') {
    super(`The PDF job ran out of ${reason}`);
    this.name = 'PdfTooComplexError';
  }
}

const SOURCE_EXTENSION = extname(__filename);
const WORKER_FILE = join(__dirname, `pdf-isolation.worker${SOURCE_EXTENSION}`);
const WORKER_EXEC_ARGV =
  SOURCE_EXTENSION === '.ts'
    ? ['--require', 'ts-node/register/transpile-only']
    : [];
const OUT_OF_MEMORY_SIGNALS = new Set(['SIGABRT', 'SIGTRAP', 'SIGKILL']);

export function runPdfTask<K extends PdfTaskKind>(
  kind: K,
  input: PdfTasks[K]['input'],
  limits: PdfTaskLimits = PDF_TASK_LIMITS,
): Promise<PdfTasks[K]['output']> {
  return new Promise((resolve, reject) => {
    const worker = fork(WORKER_FILE, [], {
      execArgv: [
        ...WORKER_EXEC_ARGV,
        `--max-old-space-size=${limits.maxOldSpaceSizeMb}`,
      ],
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let settled = false;
    const settle = (finish: () => void) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        finish();
        worker.kill('SIGKILL');
      }
    };
    const timer = setTimeout(
      () => settle(() => reject(new PdfTooComplexError('time'))),
      limits.timeoutMs,
    );
    worker.once('message', (reply: PdfTaskReply<K>) =>
      settle(() => {
        if (reply.ok) {
          resolve(reply.output);
        } else {
          reject(
            reply.problem
              ? new TemplatePdfError(reply.problem)
              : new Error(reply.message),
          );
        }
      }),
    );
    worker.once('error', (err) => settle(() => reject(err)));
    worker.once('exit', (code, signal) =>
      settle(() =>
        reject(
          signal && OUT_OF_MEMORY_SIGNALS.has(signal)
            ? new PdfTooComplexError('memory')
            : new Error(
                `PDF worker exited with ${signal ?? `code ${code}`} before replying`,
              ),
        ),
      ),
    );
    worker.send({ kind, input });
  });
}
