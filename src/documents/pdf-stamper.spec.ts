import { randomBytes } from 'node:crypto';
import { degrees, PDFDocument, PDFName } from '@cantoo/pdf-lib';
import {
  inkBounds,
  inkIn,
  pdffonts,
  pdftotext,
  pixelRect,
  renderPage,
} from '../../test/helpers/pdf-render';
import { pdfFixture } from '../../test/helpers/pdf-fixtures';
import { signaturePng } from '../../test/helpers/png-fixtures';
import type { PageGeometry, TemplateFieldRow } from './documents.types';
import {
  auditRows,
  loadStampFonts,
  type StampAudit,
  stampDocument,
  type StampInput,
  uprightBox,
} from './pdf-stamper';
import {
  MAX_TEMPLATE_BYTES,
  normaliseTemplatePdf,
  sha256Hex,
} from './template-pdf';

jest.setTimeout(60_000);

const AUDIT: StampAudit = {
  titleEn: 'Instructor agreement',
  titleZh: '教练协议',
  templateSha256: 'ab'.repeat(32),
  assignmentId: '0c1d2e3f-4a5b-4c6d-8e7f-8091a2b3c4d5',
  signerName: '王小明 Alice Wang',
  signerEmail: 'alice@example.com',
  consentEn: 'I agree to sign this document electronically.',
  consentZh: '我同意以电子方式签署本文件。',
  ip: '203.0.113.7',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15',
  viewedAt: '2026-10-12T14:00:00.000Z',
  signedAt: '2026-10-12T14:05:09.123Z',
};

const field = (
  id: string,
  type: TemplateFieldRow['type'],
  rect: Pick<TemplateFieldRow, 'x' | 'y' | 'w' | 'h'>,
  page = 1,
): TemplateFieldRow => ({
  id,
  type,
  page,
  ...rect,
  required: true,
  label_en: id,
  label_zh: null,
  prefill: null,
});

async function template(
  fixture: 'normal' | 'rotated' | 'offsetCropBox',
  rotate?: 0 | 90 | 180 | 270,
) {
  let bytes = await pdfFixture(fixture);
  if (rotate !== undefined) {
    const doc = await PDFDocument.load(bytes);
    doc.getPages().forEach((p) => p.setRotation(degrees(rotate)));
    bytes = await doc.save();
  }
  return normaliseTemplatePdf(bytes);
}

function fromReaderView(
  page: PageGeometry,
  rect: Pick<TemplateFieldRow, 'x' | 'y' | 'w' | 'h'>,
): Pick<TemplateFieldRow, 'x' | 'y' | 'w' | 'h'> {
  const frame = uprightBox(
    { x: page.x, y: page.y, w: page.width, h: page.height },
    page.rotate,
  );
  const point = (across: number, up: number) => [
    frame.origin[0] + across * frame.u[0] + up * frame.v[0],
    frame.origin[1] + across * frame.u[1] + up * frame.v[1],
  ];
  const [ax, ay] = point(rect.x, rect.y);
  const [bx, by] = point(rect.x + rect.w, rect.y + rect.h);
  return {
    x: Math.min(ax, bx),
    y: Math.min(ay, by),
    w: Math.abs(bx - ax),
    h: Math.abs(by - ay),
  };
}

function fieldsFor(page: PageGeometry, pageNo = 1): TemplateFieldRow[] {
  const at = (x: number, y: number, w: number, h: number) =>
    fromReaderView(page, { x: 130 + x, y: 100 + y, w, h });
  return [
    field('sig', 'signature', at(0, 0, 180, 50), pageNo),
    field('typed', 'signature', at(0, 70, 200, 40), pageNo),
    field('cjkSig', 'signature', at(0, 130, 160, 40), pageNo),
    field('ini', 'initials', at(240, 0, 60, 40), pageNo),
    field('name', 'full_name', at(0, 190, 240, 24), pageNo),
    field('note', 'text', at(0, 230, 240, 20), pageNo),
    field('when', 'date', at(260, 190, 100, 20), pageNo),
    field('ok', 'checkbox', at(260, 230, 18, 18), pageNo),
  ];
}

function inputFor(source: Uint8Array, fields: TemplateFieldRow[]): StampInput {
  return {
    source,
    fields,
    values: {
      name: '王小明 Alice Wang',
      note: 'Résumé on file — 已存档',
      when: '2026-10-12',
      ok: true,
    },
    signatures: {
      sig: { mode: 'drawn', png: signaturePng() },
      typed: { mode: 'typed', text: 'Alice Wang' },
      cjkSig: { mode: 'typed', text: '王小明' },
      ini: { mode: 'typed', text: 'AW' },
    },
    audit: AUDIT,
  };
}

async function expectInkInFields(
  stamped: Uint8Array,
  source: Uint8Array,
  page: PageGeometry,
  fields: TemplateFieldRow[],
  pageNo = 1,
) {
  const after = await renderPage(stamped, pageNo);
  const before = await renderPage(source, pageNo);
  const portrait = page.rotate % 180 === 0;
  expect([after.width, after.height]).toEqual(
    portrait
      ? [Math.round(page.width), Math.round(page.height)]
      : [Math.round(page.height), Math.round(page.width)],
  );
  for (const f of fields) {
    const rect = pixelRect(f, page);
    expect({ id: f.id, ink: inkIn(before, rect) }).toEqual({
      id: f.id,
      ink: 0,
    });
    expect({ id: f.id, ink: inkIn(after, rect) > 15 }).toEqual({
      id: f.id,
      ink: true,
    });
  }
  const typed = fields.find((f) => f.id === 'typed');
  if (typed) {
    const bounds = inkBounds(after, pixelRect(typed, page));
    expect(bounds!.width).toBeGreaterThan(bounds!.height * 2);
  }
}

async function expectCleanFonts(stamped: Uint8Array) {
  const { stdout, stderr } = await pdffonts(stamped);
  expect(stderr).toBe('');
  const rows = stdout
    .trim()
    .split('\n')
    .slice(2)
    .filter((row) => !row.startsWith('Helvetica '));
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row).toMatch(/\byes\s+(yes|no)\s+yes\s+\d+\s+\d+$/);
  }
  return stdout;
}

describe('stampDocument', () => {
  it('stamps Latin and CJK text, drawn and typed signatures and a checkmark, and renders them', async () => {
    const source = await template('normal');
    const fields = [
      ...fieldsFor(source.pages[0]),
      field('p2', 'text', { x: 300, y: 500, w: 200, h: 20 }, 2),
    ];
    const input = inputFor(source.bytes, fields);
    const stamped = await stampDocument({
      ...input,
      values: { ...input.values, p2: '第二页 page two' },
    });

    expect(stamped.sha256).toBe(sha256Hex(stamped.bytes));
    expect(stamped.bytes.byteLength).toBeLessThan(1024 * 1024);
    const doc = await PDFDocument.load(stamped.bytes);
    expect(doc.getPageCount()).toBe(3);
    expect(doc.catalog.has(PDFName.of('AcroForm'))).toBe(false);
    await expectInkInFields(
      stamped.bytes,
      source.bytes,
      source.pages[0],
      fieldsFor(source.pages[0]),
    );
    await expectInkInFields(
      stamped.bytes,
      source.bytes,
      source.pages[1],
      [fields[8]],
      2,
    );

    const fontList = await expectCleanFonts(stamped.bytes);
    expect(fontList).toMatch(/NotoSans/);
    expect(fontList).toMatch(/DancingScript/);
    expect(fontList).toMatch(/MaShanZheng/);

    const audit = await renderPage(stamped.bytes, 3);
    expect(
      inkIn(audit, {
        left: 0,
        top: 0,
        right: audit.width,
        bottom: audit.height,
      }),
    ).toBeGreaterThan(2000);
    const text = await pdftotext(stamped.bytes);
    for (const expected of [
      '签署记录',
      AUDIT.templateSha256,
      AUDIT.assignmentId,
      'alice@example.com',
      '203.0.113.7',
      '2026-10-12 14:00:00 UTC',
      '2026-10-12 14:05:09 UTC',
      '我同意以电子方式签署本文件。',
      '教练协议',
    ]) {
      expect(text).toContain(expected);
    }
  });

  it.each([0, 90, 180, 270] as const)(
    'draws at the field rects on a page rotated %i degrees',
    async (rotate) => {
      const source = await template('normal', rotate);
      expect(source.pages[0].rotate).toBe(rotate);
      const fields = fieldsFor(source.pages[0]);
      const stamped = await stampDocument(inputFor(source.bytes, fields));
      await expectInkInFields(
        stamped.bytes,
        source.bytes,
        source.pages[0],
        fields,
      );
      await expectCleanFonts(stamped.bytes);
    },
  );

  it('draws at absolute user-space rects on an offset crop box', async () => {
    const source = await template('offsetCropBox');
    expect(source.pages[0]).toMatchObject({ x: 36, y: 48 });
    const fields = fieldsFor(source.pages[0]);
    const stamped = await stampDocument(inputFor(source.bytes, fields));
    await expectInkInFields(
      stamped.bytes,
      source.bytes,
      source.pages[0],
      fields,
    );
  });

  it('leaves unticked checkboxes, missing values and missing signatures blank and skips Latin-only script fonts', async () => {
    const source = await template('normal');
    const fields = fieldsFor(source.pages[0]);
    const stamped = await stampDocument({
      source: source.bytes,
      fields: [
        ...fields,
        field('ghost', 'text', { x: 10, y: 10, w: 5, h: 5 }, 9),
      ],
      values: { ok: false, note: '   ' },
      signatures: { typed: { mode: 'typed', text: 'Alice' } },
      audit: {
        ...AUDIT,
        signerEmail: null,
        ip: null,
        userAgent: null,
        viewedAt: null,
        titleZh: null,
      },
    });
    const after = await renderPage(stamped.bytes, 1);
    for (const f of fields.filter((f) => f.id !== 'typed')) {
      expect({
        id: f.id,
        ink: inkIn(after, pixelRect(f, source.pages[0])),
      }).toEqual({ id: f.id, ink: 0 });
    }
    const fontList = await expectCleanFonts(stamped.bytes);
    expect(fontList).not.toMatch(/MaShanZheng/);
  });

  it('continues the audit page onto a second page when the evidence is long', async () => {
    const source = await template('rotated');
    const stamped = await stampDocument({
      source: source.bytes,
      fields: [],
      values: {},
      signatures: {},
      audit: {
        ...AUDIT,
        userAgent: 'x'.repeat(4000),
        linkEvidence: 'token sha256 ' + 'f'.repeat(64),
      },
    });
    const doc = await PDFDocument.load(stamped.bytes);
    expect(doc.getPageCount()).toBe(3);
  });

  it('logs peak RSS while stamping a 20 MB template', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const width = 2600;
    const height = Math.floor((19.5 * 1024 * 1024) / (width * 3));
    const noise = doc.context.stream(randomBytes(width * height * 3), {
      Type: 'XObject',
      Subtype: 'Image',
      Width: width,
      Height: height,
      BitsPerComponent: 8,
      ColorSpace: 'DeviceRGB',
    });
    page.node.setXObject(PDFName.of('Noise'), doc.context.register(noise));
    const source = await doc.save();
    expect(source.byteLength).toBeGreaterThan(19 * 1024 * 1024);
    expect(source.byteLength).toBeLessThanOrEqual(MAX_TEMPLATE_BYTES);
    await loadStampFonts();
    global.gc?.();
    const before = process.memoryUsage().rss;
    let peak = before;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 5);
    const fields = fieldsFor({
      width: 612,
      height: 792,
      rotate: 0,
      x: 0,
      y: 0,
    });
    const stamped = await stampDocument(inputFor(source, fields));
    clearInterval(sampler);
    peak = Math.max(peak, process.memoryUsage().rss);
    const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
    console.log(
      `pdf-stamper 20 MB fixture: template ${mb(source.byteLength)} MB, output ${mb(stamped.bytes.byteLength)} MB, ` +
        `RSS before ${mb(before)} MB, sampled peak ${mb(peak)} MB (+${mb(peak - before)} MB), ` +
        `process maxRSS ${mb(process.resourceUsage().maxRSS * 1024)} MB`,
    );
    expect(stamped.bytes.byteLength).toBeGreaterThan(source.byteLength);
  });
});

describe('uprightBox', () => {
  const rect = { x: 100, y: 200, w: 50, h: 20 };

  it.each([
    [0, [100, 200], 50, 20],
    [90, [150, 200], 20, 50],
    [180, [150, 220], 50, 20],
    [270, [100, 220], 20, 50],
  ] as const)('maps rotation %i', (rotate, origin, width, height) => {
    expect(uprightBox(rect, rotate)).toMatchObject({
      origin,
      width,
      height,
      rotate,
    });
  });
});

describe('auditRows', () => {
  it('adds link evidence only when present', () => {
    expect(auditRows(AUDIT).map(([label]) => label)).not.toContain(
      'Signing link / 签署链接',
    );
    expect(auditRows({ ...AUDIT, linkEvidence: 'x' }).at(-1)).toEqual([
      'Signing link / 签署链接',
      'x',
    ]);
  });

  it('names the signed language version only when it has one', () => {
    expect(auditRows(AUDIT).map(([label]) => label)).not.toContain(
      'Version signed / 签署版本',
    );
    expect(auditRows({ ...AUDIT, language: 'en' })[1]).toEqual([
      'Version signed / 签署版本',
      'English / 英文',
    ]);
  });
});

describe('loadStampFonts', () => {
  it('reads the fonts once', async () => {
    const first = await loadStampFonts();
    expect(await loadStampFonts()).toBe(first);
    expect(first.text.byteLength).toBeGreaterThan(1_000_000);
  });

  it('retries after a failed read', async () => {
    await jest.isolateModulesAsync(async () => {
      const readFile = jest
        .fn()
        .mockRejectedValueOnce(new Error('EIO'))
        .mockResolvedValue(Buffer.from('font'));
      jest.doMock('node:fs/promises', () => ({ readFile }));
      const stamper =
        jest.requireActual<typeof import('./pdf-stamper')>('./pdf-stamper');
      await expect(stamper.loadStampFonts()).rejects.toThrow('EIO');
      await expect(stamper.loadStampFonts()).resolves.toMatchObject({
        text: Buffer.from('font'),
      });
    });
  });
});
