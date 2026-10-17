import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as fontkit from '@cantoo/fontkit';
import {
  degrees,
  PDFDocument,
  type PDFFont,
  PDFName,
  type PDFPage,
  rgb,
} from '@cantoo/pdf-lib';
import type {
  DocumentLanguage,
  PageGeometry,
  TemplateFieldRow,
} from './documents.types';
import { pageGeometry, sha256Hex } from './template-pdf';

export const FONT_DIR = join(__dirname, '..', '..', 'assets', 'fonts');
export const FONT_FILES = {
  text: 'NotoSansSC-Regular.otf',
  latinScript: 'DancingScript-Variable.ttf',
  cjkScript: 'MaShanZheng-Regular.ttf',
} as const;
type FontRole = keyof typeof FONT_FILES;

const INK = rgb(0.05, 0.1, 0.35);
const TEXT_COLOUR = rgb(0.1, 0.1, 0.1);
const CJK = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/;
const AUDIT_PAGE: [number, number] = [612, 792];
const AUDIT_MARGIN = 54;

/** A signature as drawn (PNG bytes) or typed (rendered in a script font). */
export type StampSignature =
  | { mode: 'drawn'; png: Uint8Array }
  | { mode: 'typed'; text: string };

/** Evidence printed on the appended audit page. */
export interface StampAudit {
  titleEn: string;
  titleZh: string | null;
  templateSha256: string;
  assignmentId: string;
  signerName: string;
  signerEmail: string | null;
  consentEn: string;
  consentZh: string;
  ip: string | null;
  userAgent: string | null;
  viewedAt: string | null;
  signedAt: string;
  linkEvidence?: string | null;
  language?: DocumentLanguage | null;
}

const LANGUAGE_NAMES: Record<DocumentLanguage, string> = {
  en: 'English / 英文',
  zh: 'Chinese / 中文',
};

export interface StampInput {
  source: Uint8Array;
  fields: readonly TemplateFieldRow[];
  /** Resolved text, date and full-name values, and checkbox states, by field id. */
  values: Readonly<Record<string, string | boolean>>;
  signatures: Readonly<Record<string, StampSignature>>;
  audit: StampAudit;
}

export interface StampedPdf {
  bytes: Uint8Array;
  sha256: string;
}

let fontBytes: Promise<Record<FontRole, Uint8Array>> | null = null;

/** Reads the bundled fonts on first use and keeps the bytes for the life of the process. */
export function loadStampFonts(): Promise<Record<FontRole, Uint8Array>> {
  fontBytes ??= (async () => {
    const [text, latinScript, cjkScript] = await Promise.all(
      [FONT_FILES.text, FONT_FILES.latinScript, FONT_FILES.cjkScript].map(
        (file) => readFile(join(FONT_DIR, file)),
      ),
    );
    return { text, latinScript, cjkScript };
  })().catch((err: unknown) => {
    fontBytes = null;
    throw err;
  });
  return fontBytes;
}

/**
 * A field rect seen upright by the reader. `origin` is the reader's
 * bottom-left corner in user space; `u` runs along the text baseline and `v`
 * up the glyphs, so the frame follows the page's `/Rotate`.
 */
interface UprightBox {
  origin: [number, number];
  u: [number, number];
  v: [number, number];
  width: number;
  height: number;
  rotate: number;
}

/** Maps a field rect to the reader's upright frame for a page rotated by `rotate`. */
export function uprightBox(
  field: Pick<TemplateFieldRow, 'x' | 'y' | 'w' | 'h'>,
  rotate: PageGeometry['rotate'],
): UprightBox {
  const { x, y, w, h } = field;
  switch (rotate) {
    case 90:
      return {
        origin: [x + w, y],
        u: [0, 1],
        v: [-1, 0],
        width: h,
        height: w,
        rotate,
      };
    case 180:
      return {
        origin: [x + w, y + h],
        u: [-1, 0],
        v: [0, -1],
        width: w,
        height: h,
        rotate,
      };
    case 270:
      return {
        origin: [x, y + h],
        u: [0, -1],
        v: [1, 0],
        width: h,
        height: w,
        rotate,
      };
    default:
      return {
        origin: [x, y],
        u: [1, 0],
        v: [0, 1],
        width: w,
        height: h,
        rotate: 0,
      };
  }
}

function at(
  box: UprightBox,
  across: number,
  up: number,
): { x: number; y: number } {
  return {
    x: box.origin[0] + across * box.u[0] + up * box.v[0],
    y: box.origin[1] + across * box.u[1] + up * box.v[1],
  };
}

function fitSize(
  font: PDFFont,
  text: string,
  maxWidth: number,
  maxSize: number,
) {
  const width = font.widthOfTextAtSize(text, maxSize);
  return width > maxWidth ? Math.max(1, (maxSize * maxWidth) / width) : maxSize;
}

function drawLineOfText(
  page: PDFPage,
  box: UprightBox,
  text: string,
  font: PDFFont,
  maxSize: number,
  align: 'left' | 'center',
): void {
  const pad = Math.min(2, box.width / 10);
  const size = fitSize(font, text, box.width - 2 * pad, maxSize);
  const width = font.widthOfTextAtSize(text, size);
  const height = font.heightAtSize(size, { descender: false });
  const descent = Math.abs(font.heightAtSize(size) - height);
  const across = align === 'center' ? (box.width - width) / 2 : pad;
  const up = Math.max(0, (box.height - height) / 2) + descent / 2;
  page.drawText(text, {
    ...at(box, across, up),
    size,
    font,
    color: TEXT_COLOUR,
    rotate: degrees(box.rotate),
  });
}

class StampFonts {
  private readonly embedded = new Map<FontRole, Promise<PDFFont>>();

  constructor(
    private readonly doc: PDFDocument,
    private readonly bytes: Record<FontRole, Uint8Array>,
  ) {}

  get(role: FontRole): Promise<PDFFont> {
    let font = this.embedded.get(role);
    if (!font) {
      font = this.doc.embedFont(this.bytes[role], { subset: true });
      this.embedded.set(role, font);
    }
    return font;
  }
}

async function drawSignature(
  doc: PDFDocument,
  page: PDFPage,
  box: UprightBox,
  signature: StampSignature,
  fonts: StampFonts,
): Promise<void> {
  if (signature.mode === 'typed') {
    const font = await fonts.get(
      CJK.test(signature.text) ? 'cjkScript' : 'latinScript',
    );
    drawLineOfText(
      page,
      box,
      signature.text,
      font,
      box.height * 0.75,
      'center',
    );
    return;
  }
  const image = await doc.embedPng(signature.png);
  const scale = Math.min(box.width / image.width, box.height / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  page.drawImage(image, {
    ...at(box, (box.width - width) / 2, (box.height - height) / 2),
    width,
    height,
    rotate: degrees(box.rotate),
  });
}

function drawCheck(page: PDFPage, box: UprightBox): void {
  const side = Math.min(box.width, box.height);
  const left = (box.width - side) / 2;
  const bottom = (box.height - side) / 2;
  const thickness = Math.max(1, side / 8);
  const points: [number, number][] = [
    [0.2, 0.5],
    [0.42, 0.25],
    [0.82, 0.8],
  ];
  for (let i = 0; i < points.length - 1; i += 1) {
    page.drawLine({
      start: at(box, left + points[i][0] * side, bottom + points[i][1] * side),
      end: at(
        box,
        left + points[i + 1][0] * side,
        bottom + points[i + 1][1] * side,
      ),
      thickness,
      color: INK,
    });
  }
}

async function drawField(
  doc: PDFDocument,
  page: PDFPage,
  field: TemplateFieldRow,
  input: StampInput,
  fonts: StampFonts,
): Promise<void> {
  const box = uprightBox(field, pageGeometry(page).rotate);
  if (field.type === 'signature' || field.type === 'initials') {
    const signature = input.signatures[field.id];
    if (signature) {
      await drawSignature(doc, page, box, signature, fonts);
    }
    return;
  }
  const value = input.values[field.id];
  if (field.type === 'checkbox') {
    if (value === true) {
      drawCheck(page, box);
    }
    return;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const size = Math.min(12, box.height * 0.7);
    drawLineOfText(
      page,
      box,
      value.trim(),
      await fonts.get('text'),
      size,
      'left',
    );
  }
}

function wrap(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
): string[] {
  const fits = (candidate: string) =>
    font.widthOfTextAtSize(candidate, size) <= maxWidth;
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    const tokens = paragraph.match(/[\u2e80-\u9fff\uf900-\uffef]|\S+|\s+/g);
    for (const token of tokens ?? []) {
      if (fits((line + token).trimEnd())) {
        line += token;
        continue;
      }
      if (line.trim() !== '') {
        lines.push(line.trimEnd());
      }
      line = '';
      for (const char of token.trimStart()) {
        if (line !== '' && !fits(line + char)) {
          lines.push(line);
          line = '';
        }
        line += char;
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

function utc(iso: string | null): string {
  return iso
    ? `${new Date(iso).toISOString().replace('T', ' ').slice(0, 19)} UTC`
    : '—';
}

/** Rows of the audit page: bilingual label, then value. */
export function auditRows(audit: StampAudit): [string, string][] {
  return [
    [
      'Document / 文件',
      [audit.titleEn, audit.titleZh].filter(Boolean).join('\n'),
    ],
    ...(audit.language
      ? ([['Version signed / 签署版本', LANGUAGE_NAMES[audit.language]]] as [
          string,
          string,
        ][])
      : []),
    ['Original document SHA-256 / 原始文件 SHA-256', audit.templateSha256],
    ['Assignment ID / 签署编号', audit.assignmentId],
    ['Signer / 签署人', audit.signerName],
    ['Email / 电子邮箱', audit.signerEmail ?? '—'],
    ['Consent / 同意声明', `${audit.consentEn}\n${audit.consentZh}`],
    ['IP address / IP 地址', audit.ip ?? '—'],
    ['User agent / 浏览器', audit.userAgent ?? '—'],
    ['Viewed at / 查看时间', utc(audit.viewedAt)],
    ['Signed at / 签署时间', utc(audit.signedAt)],
    ...(audit.linkEvidence
      ? ([['Signing link / 签署链接', audit.linkEvidence]] as [
          string,
          string,
        ][])
      : []),
  ];
}

function drawAuditPage(
  doc: PDFDocument,
  font: PDFFont,
  audit: StampAudit,
): void {
  let page = doc.addPage(AUDIT_PAGE);
  const width = AUDIT_PAGE[0] - 2 * AUDIT_MARGIN;
  let y = AUDIT_PAGE[1] - AUDIT_MARGIN;
  const line = (text: string, size: number, gap = 4) => {
    if (y - size < AUDIT_MARGIN) {
      page = doc.addPage(AUDIT_PAGE);
      y = AUDIT_PAGE[1] - AUDIT_MARGIN;
    }
    y -= size;
    page.drawText(text, { x: AUDIT_MARGIN, y, size, font, color: TEXT_COLOUR });
    y -= gap;
  };
  line('Signature record / 签署记录', 18, 16);
  for (const [label, value] of auditRows(audit)) {
    line(label, 9, 3);
    for (const text of wrap(value, font, 11, width)) {
      line(text, 11);
    }
    y -= 8;
  }
  line(
    'The SHA-256 of this signed file is kept by SSnow and shown with your copy.',
    8,
    2,
  );
  line('本签署文件的 SHA-256 由 SSnow 保存，并随您的副本一同显示。', 8, 2);
}

/**
 * Draws field values and signatures onto the template at their rects (rotation
 * and offset crop boxes included), flattens any form, appends the bilingual
 * audit page and returns the saved bytes with their SHA-256. Fonts are
 * embedded as subsets; script fonts only when a typed signature needs them.
 */
export async function stampDocument(input: StampInput): Promise<StampedPdf> {
  const doc = await PDFDocument.load(input.source, { updateMetadata: false });
  doc.registerFontkit(fontkit);
  const fonts = new StampFonts(doc, await loadStampFonts());
  const pages = doc.getPages();
  for (const field of input.fields) {
    const page = pages[field.page - 1];
    if (page) {
      await drawField(doc, page, field, input, fonts);
    }
  }
  if (doc.catalog.has(PDFName.of('AcroForm'))) {
    doc.getForm().flatten();
  }
  drawAuditPage(doc, await fonts.get('text'), input.audit);
  const bytes = await doc.save({ useObjectStreams: true });
  return { bytes, sha256: sha256Hex(bytes) };
}
