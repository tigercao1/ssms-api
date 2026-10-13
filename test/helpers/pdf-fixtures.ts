import { degrees, PDFDocument, PDFName, StandardFonts } from '@cantoo/pdf-lib';

/** Template PDFs generated in test setup; no binary fixtures in the repo. */
export type PdfFixture =
  | 'normal'
  | 'ownerEncrypted'
  | 'userPassword'
  | 'acroForm'
  | 'xfa'
  | 'rotated'
  | 'offsetCropBox';

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
