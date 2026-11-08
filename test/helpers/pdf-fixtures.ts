import { deflateSync } from 'node:zlib';
import {
  degrees,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFObject,
  PDFStream,
  PDFString,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
  StandardFonts,
} from '@cantoo/pdf-lib';
import { signaturePng } from './png-fixtures';

/** Template PDFs generated in test setup; no binary fixtures in the repo. */
export type PdfFixture =
  | 'normal'
  | 'ownerEncrypted'
  | 'userPassword'
  | 'acroForm'
  | 'xfa'
  | 'rotated'
  | 'offsetCropBox'
  | 'activeContent'
  | 'presStepsScript'
  | 'pageAttachedFile'
  | 'xObjectAttachedFile'
  | 'image';

async function base(
  pages: [number, number][] = [[612, 792]],
): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  pages.forEach(([w, h], i) => {
    const page = doc.addPage([w, h]);
    page.drawText(`Page ${i + 1}`, { x: 72, y: h - 72, size: 18, font });
  });
  return doc;
}

async function activeContent(): Promise<Uint8Array> {
  const doc = await base([
    [612, 792],
    [612, 792],
  ]);
  const ctx = doc.context;
  const page = doc.getPage(0);
  const script = ctx.register(
    ctx.obj({ S: 'JavaScript', JS: PDFString.of('app.alert("active")') }),
  );
  const file = ctx.register(
    ctx.flateStream('attached file', { Type: 'EmbeddedFile' }),
  );
  const fileSpec = ctx.register(
    ctx.obj({
      Type: 'Filespec',
      F: PDFString.of('attached.txt'),
      EF: { F: file },
    }),
  );
  const annotation = (subtype: string, extra: Record<string, unknown>) =>
    ctx.register(
      ctx.obj({
        Type: 'Annot',
        Subtype: subtype,
        Rect: [0, 0, 20, 20],
        ...extra,
      }),
    );
  page.node.set(PDFName.of('AA'), ctx.obj({ O: script }));
  page.node.set(
    PDFName.of('Annots'),
    ctx.obj([
      annotation('FileAttachment', { FS: fileSpec, AA: { E: script } }),
      annotation('Link', {
        A: { S: 'URI', URI: PDFString.of('https://example.com') },
      }),
      annotation('Link', { A: { S: 'Launch', F: PDFString.of('calc.exe') } }),
    ]),
  );
  const name = doc.getForm().createTextField('applicant.name');
  name.setText('Alice Example');
  name.addToPage(page, { x: 72, y: 600, width: 220, height: 28 });
  name.acroField.dict.set(PDFName.of('AA'), ctx.obj({ K: script }));
  doc.catalog.set(PDFName.of('OpenAction'), script);
  doc.catalog.set(PDFName.of('AA'), ctx.obj({ WC: script }));
  doc.catalog.set(
    PDFName.of('Names'),
    ctx.obj({
      JavaScript: { Names: [PDFString.of('open'), script] },
      EmbeddedFiles: { Names: [PDFString.of('attached.txt'), fileSpec] },
    }),
  );
  return doc.save();
}

async function withPageExtras(
  add: (doc: PDFDocument, script: PDFObject, files: PDFObject) => void,
): Promise<Uint8Array> {
  const doc = await base([
    [612, 792],
    [612, 792],
  ]);
  const ctx = doc.context;
  const script = ctx.register(
    ctx.obj({ S: 'JavaScript', JS: PDFString.of('app.alert("active")') }),
  );
  const file = ctx.register(
    ctx.flateStream('attached file', { Type: 'EmbeddedFile' }),
  );
  const fileSpec = ctx.register(
    ctx.obj({
      Type: 'Filespec',
      F: PDFString.of('attached.txt'),
      AFRelationship: 'Supplement',
      EF: { F: file },
    }),
  );
  add(doc, script, ctx.obj([fileSpec]));
  return doc.save();
}

const builders: Record<PdfFixture, () => Promise<Uint8Array>> = {
  normal: async () =>
    (
      await base([
        [612, 792],
        [612, 792],
      ])
    ).save(),
  ownerEncrypted: async () => {
    const doc = await base();
    doc.encrypt({ ownerPassword: 'owner-secret' });
    return doc.save();
  },
  userPassword: async () => {
    const doc = await base();
    doc.encrypt({ ownerPassword: 'owner-secret', userPassword: 'user-secret' });
    return doc.save();
  },
  acroForm: async () => {
    const doc = await base();
    const page = doc.getPage(0);
    const form = doc.getForm();
    const name = form.createTextField('applicant.name');
    name.setText('Alice Example');
    name.addToPage(page, { x: 72, y: 600, width: 220, height: 28 });
    const agree = form.createCheckBox('applicant.agree');
    agree.check();
    agree.addToPage(page, { x: 72, y: 560, width: 18, height: 18 });
    return doc.save();
  },
  xfa: async () => {
    const doc = await base();
    const xfa = doc.context.flateStream(
      '<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"><template/></xdp:xdp>',
    );
    doc.catalog.set(
      PDFName.of('AcroForm'),
      doc.context.obj({ Fields: [], XFA: doc.context.register(xfa) }),
    );
    return doc.save();
  },
  rotated: async () => {
    const doc = await base([[612, 792]]);
    doc.getPage(0).setRotation(degrees(90));
    return doc.save();
  },
  offsetCropBox: async () => {
    const doc = await base([[612, 792]]);
    doc.getPage(0).setCropBox(36, 48, 540, 700);
    return doc.save();
  },
  activeContent,
  presStepsScript: () =>
    withPageExtras((doc, script) =>
      doc
        .getPage(0)
        .node.set(
          PDFName.of('PresSteps'),
          doc.context.obj({ Type: 'NavNode', NA: script, PA: script }),
        ),
    ),
  pageAttachedFile: () =>
    withPageExtras((doc, _script, files) =>
      doc.getPage(0).node.set(PDFName.of('AF'), files),
    ),
  xObjectAttachedFile: () =>
    withPageExtras((doc, script, files) => {
      const page = doc.getPage(0);
      const form = doc.context.register(
        doc.context.flateStream('72 300 m 300 300 l S', {
          Type: 'XObject',
          Subtype: 'Form',
          BBox: [0, 0, 612, 792],
          AF: files,
          AA: { O: script },
        }),
      );
      page.node.setXObject(PDFName.of('Extra'), form);
      page.pushOperators(
        pushGraphicsState(),
        drawObject('Extra'),
        popGraphicsState(),
      );
    }),
  image: async () => {
    const doc = await base([
      [612, 792],
      [612, 792],
    ]);
    const image = await doc.embedPng(signaturePng());
    doc.getPage(0).drawImage(image, { x: 72, y: 400, width: 300, height: 100 });
    return doc.save();
  },
};

/** Builds one template fixture PDF. */
export function pdfFixture(name: PdfFixture): Promise<Uint8Array> {
  return builders[name]();
}

/** A single-page PDF of the given size, for page-layout comparisons. */
export async function pdfOfSize(
  pages: [number, number][],
): Promise<Uint8Array> {
  return (await base(pages)).save();
}

const ACTIVE_KEYS = new Set([
  'AA',
  'AF',
  'PresSteps',
  'A',
  'OpenAction',
  'JS',
  'JavaScript',
  'URI',
  'Names',
  'EmbeddedFiles',
  'EF',
  'Annots',
  'AcroForm',
]);

const ACTIVE_VALUES = new Set(
  ['FileAttachment', 'Launch', 'JavaScript'].map((name) => PDFName.of(name)),
);

export async function activeContentIn(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const found = new Set<string>();
  const visit = (object: PDFObject) => {
    if (object instanceof PDFStream) {
      visit(object.dict);
    } else if (object instanceof PDFArray) {
      object.asArray().forEach(visit);
    } else if (object instanceof PDFDict) {
      for (const [key, value] of object.entries()) {
        const name = key.decodeText();
        const target = doc.context.lookup(value);
        const empty = target instanceof PDFArray && target.size() === 0;
        if (ACTIVE_KEYS.has(name) && !empty) {
          found.add(name);
        }
        if (value instanceof PDFName && ACTIVE_VALUES.has(value)) {
          found.add(value.decodeText());
        }
        visit(value);
      }
    }
  };
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    visit(object);
  }
  return [...found].sort();
}

export function annotationHeavyPdf(count: number): Buffer {
  const keys = Array.from({ length: 30 }, (_, i) => `/K${i} ${i}`).join(' ');
  let offsets = '';
  let objects = '';
  for (let i = 0; i < count; i += 1) {
    offsets += `${i + 7} ${objects.length} `;
    objects += `<< /Type /Annot /Subtype /Text /Rect [0 0 1 1] ${keys} >>\n`;
  }
  const stream = deflateSync(Buffer.from(offsets + objects));
  const refs = Array.from({ length: count }, (_, i) => `${i + 7} 0 R`).join(
    ' ',
  );
  return Buffer.concat([
    Buffer.from(
      `%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n` +
        `2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n` +
        `3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Annots [${refs}] >> endobj\n` +
        `6 0 obj << /Type /ObjStm /N ${count} /First ${offsets.length} /Length ${stream.length} /Filter /FlateDecode >> stream\n`,
    ),
    stream,
    Buffer.from('\nendstream endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n'),
  ]);
}
