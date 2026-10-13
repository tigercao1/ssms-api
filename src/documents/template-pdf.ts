import { createHash } from 'node:crypto';
import { PDFDict, PDFDocument, PDFName, type PDFPage } from '@cantoo/pdf-lib';
import type { PageGeometry } from './documents.types';

export const MAX_TEMPLATE_BYTES = 20 * 1024 * 1024;
export const PDF_CONTENT_TYPE = 'application/pdf';

export type TemplatePdfProblem =
  | 'invalid'
  | 'password_protected'
  | 'xfa'
  | 'no_pages';

const PROBLEM_MESSAGES: Record<TemplatePdfProblem, string> = {
  invalid: 'The file is not a readable PDF',
  password_protected:
    'The PDF needs a password to open; upload an unprotected copy',
  xfa: 'XFA forms are not supported; print the form to a regular PDF and upload that',
  no_pages: 'The PDF has no pages',
};

/** A PDF the template pipeline refuses, with a message fit for the admin. */
export class TemplatePdfError extends Error {
  constructor(readonly problem: TemplatePdfProblem) {
    super(PROBLEM_MESSAGES[problem]);
    this.name = 'TemplatePdfError';
  }
}

/** A validated, re-saved template source. */
export interface NormalisedTemplatePdf {
  bytes: Uint8Array;
  sha256: string;
  pageCount: number;
  pages: PageGeometry[];
}

/** Lowercase hex SHA-256. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function rotation(page: PDFPage): PageGeometry['rotate'] {
  const angle = page.getRotation().angle;
  if (!Number.isInteger(angle) || angle % 90 !== 0) {
    return 0;
  }
  return (((angle % 360) + 360) % 360) as PageGeometry['rotate'];
}

/** The visible box of the unrotated page: CropBox clipped to MediaBox, as pdf.js renders it. */
export function pageGeometry(page: PDFPage): PageGeometry {
  const media = page.getMediaBox();
  const crop = page.getCropBox();
  const x = Math.max(media.x, crop.x);
  const y = Math.max(media.y, crop.y);
  const right = Math.min(media.x + media.width, crop.x + crop.width);
  const top = Math.min(media.y + media.height, crop.y + crop.height);
  const visible = right > x && top > y;
  return visible
    ? { width: right - x, height: top - y, rotate: rotation(page), x, y }
    : { ...media, rotate: rotation(page) };
}

async function open(bytes: Uint8Array): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes, {
      password: '',
      preserveXFA: true,
      updateMetadata: false,
    });
  } catch (err) {
    if (/password/i.test((err as Error).message)) {
      throw new TemplatePdfError('password_protected');
    }
    throw new TemplatePdfError('invalid');
  }
}

function hasXfa(doc: PDFDocument): boolean {
  const acroForm = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  return acroForm?.has(PDFName.of('XFA')) ?? false;
}

/**
 * Validates and normalises an uploaded template PDF: opens it with an empty
 * password (owner-only encryption is removed, a user password is refused),
 * refuses XFA, flattens any AcroForm into page content, then copies the pages
 * into a fresh document so no encryption, form, script or metadata survives.
 */
export async function normaliseTemplatePdf(
  input: Uint8Array,
): Promise<NormalisedTemplatePdf> {
  const source = await open(input);
  if (hasXfa(source)) {
    throw new TemplatePdfError('xfa');
  }
  if (source.getPageCount() === 0) {
    throw new TemplatePdfError('no_pages');
  }
  if (source.catalog.has(PDFName.of('AcroForm'))) {
    try {
      source.getForm().flatten();
    } catch {
      throw new TemplatePdfError('invalid');
    }
  }
  const output = await PDFDocument.create({ updateMetadata: false });
  const copied = await output.copyPages(source, source.getPageIndices());
  for (const page of copied) {
    output.addPage(page);
  }
  const bytes = await output.save({ useObjectStreams: true });
  return {
    bytes,
    sha256: sha256Hex(bytes),
    pageCount: copied.length,
    pages: output.getPages().map(pageGeometry),
  };
}

const TOLERANCE = 0.01;

/** Whether placed fields stay valid on `next`: same page count and the same visible box per page. */
export function samePageLayout(
  previous: readonly PageGeometry[],
  next: readonly PageGeometry[],
): boolean {
  return (
    previous.length === next.length &&
    previous.every((page, i) =>
      (['width', 'height', 'x', 'y'] as const).every(
        (key) => Math.abs((page[key] ?? 0) - (next[i][key] ?? 0)) < TOLERANCE,
      ),
    )
  );
}
