import * as fontkit from '@cantoo/fontkit';
import { PDFDocument, type PDFFont, type PDFPage, rgb } from '@cantoo/pdf-lib';
import type { FormField } from './form-templates.types';
import {
  drawAuditPage,
  loadStampFonts,
  type StampAudit,
  type StampedPdf,
  wrap,
} from './pdf-stamper';
import { sha256Hex } from './template-pdf';

const PAGE: [number, number] = [612, 792];
const MARGIN = 54;
const TEXT = rgb(0.1, 0.1, 0.1);
const MUTED = rgb(0.4, 0.4, 0.4);
const SIGNATURE_BOX = { width: 220, height: 70 };
const BODY_SIZE = 10.5;
const HEADING_SIZES = [15, 13, 11.5];
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const EMPHASIS = /\*\*|__/g;

export interface FormPdfInput {
  title: string;
  bodyMarkdown: string;
  fields: readonly FormField[];
  values: Readonly<Record<string, string>>;
  signatures: Readonly<Record<string, Uint8Array>>;
  answersHeading: string;
  audit: StampAudit;
}

class Cursor {
  private page: PDFPage;
  private y = PAGE[1] - MARGIN;
  readonly width = PAGE[0] - 2 * MARGIN;

  constructor(
    private readonly doc: PDFDocument,
    readonly font: PDFFont,
  ) {
    this.page = doc.addPage(PAGE);
  }

  private room(height: number): void {
    if (this.y - height < MARGIN) {
      this.page = this.doc.addPage(PAGE);
      this.y = PAGE[1] - MARGIN;
    }
  }

  gap(points: number): void {
    this.y -= points;
  }

  text(text: string, size: number, indent = 0, color = TEXT): void {
    for (const line of wrap(text, this.font, size, this.width - indent)) {
      this.room(size * 1.35);
      this.y -= size * 1.35;
      this.page.drawText(line, {
        x: MARGIN + indent,
        y: this.y + size * 0.3,
        size,
        font: this.font,
        color,
      });
    }
  }

  async image(png: Uint8Array): Promise<void> {
    const image = await this.doc.embedPng(png);
    const scale = Math.min(
      SIGNATURE_BOX.width / image.width,
      SIGNATURE_BOX.height / image.height,
      1,
    );
    const height = image.height * scale;
    this.room(height + 4);
    this.y -= height + 4;
    this.page.drawImage(image, {
      x: MARGIN,
      y: this.y,
      width: image.width * scale,
      height,
    });
  }
}

function drawMarkdown(cursor: Cursor, markdown: string): void {
  for (const raw of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(EMPHASIS, '');
    const heading = HEADING.exec(line);
    const bullet = BULLET.exec(line);
    if (line.trim() === '') {
      cursor.gap(BODY_SIZE * 0.6);
    } else if (heading) {
      const size =
        HEADING_SIZES[Math.min(heading[1].length, HEADING_SIZES.length) - 1];
      cursor.gap(size * 0.4);
      cursor.text(heading[2], size);
    } else if (bullet) {
      cursor.text(`•  ${bullet[1]}`, BODY_SIZE, 12);
    } else {
      cursor.text(line, BODY_SIZE);
    }
  }
}

export async function renderFormPdf(input: FormPdfInput): Promise<StampedPdf> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont((await loadStampFonts()).text, {
    subset: true,
  });
  const cursor = new Cursor(doc, font);
  cursor.text(input.title, 18);
  cursor.gap(8);
  drawMarkdown(cursor, input.bodyMarkdown);
  cursor.gap(16);
  cursor.text(input.answersHeading, HEADING_SIZES[1]);
  for (const field of input.fields) {
    cursor.gap(6);
    cursor.text(field.label, 9, 0, MUTED);
    const png = input.signatures[field.key];
    if (png) {
      await cursor.image(png);
    } else {
      cursor.text(input.values[field.key] ?? '—', 11);
    }
  }
  drawAuditPage(doc, font, input.audit);
  const bytes = await doc.save({ useObjectStreams: true });
  return { bytes, sha256: sha256Hex(bytes) };
}
