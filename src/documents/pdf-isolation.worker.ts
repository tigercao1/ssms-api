import { stampFormPdf } from './form-pdf';
import type { PdfTaskKind, PdfTaskReply, PdfTasks } from './pdf-isolation';
import { normaliseTemplatePdf, TemplatePdfError } from './template-pdf';

const tasks: {
  [K in PdfTaskKind]: (
    input: PdfTasks[K]['input'],
  ) => Promise<PdfTasks[K]['output']>;
} = {
  normaliseForm: (input) =>
    normaliseTemplatePdf(input, { stripAnnotations: true }),
  stampForm: (input) => stampFormPdf(input),
};

async function run({
  kind,
  input,
}: {
  kind: PdfTaskKind;
  input: never;
}): Promise<PdfTaskReply> {
  try {
    return { ok: true, output: await tasks[kind](input) };
  } catch (err) {
    return {
      ok: false,
      problem: err instanceof TemplatePdfError ? err.problem : null,
      message: (err as Error).message,
    };
  }
}

process.once('message', (task: { kind: PdfTaskKind; input: never }) => {
  void run(task).then((reply) => process.send!(reply));
});
