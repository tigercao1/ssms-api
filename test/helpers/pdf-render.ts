import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { PageGeometry } from '../../src/documents/documents.types';

const run = promisify(execFile);

/** A grayscale render of one page: one byte per pixel, 0 = black. */
export interface RenderedPage {
  width: number;
  height: number;
  pixels: Uint8Array;
}

async function withPdf<T>(
  bytes: Uint8Array,
  fn: (dir: string, file: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'ssms-pdf-'));
  try {
    const file = join(dir, 'doc.pdf');
    await writeFile(file, bytes);
    return await fn(dir, file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function parsePgm(data: Buffer): RenderedPage {
  const header = /^P5\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(
    data.subarray(0, 64).toString('latin1'),
  );
  if (!header) {
    throw new Error('pdftoppm did not produce a PGM');
  }
  const width = Number(header[1]);
  const height = Number(header[2]);
  return {
    width,
    height,
    pixels: data.subarray(header[0].length, header[0].length + width * height),
  };
}

/** Renders the crop box of page `page` (1-based) with poppler's `pdftoppm` at 72 dpi, so 1 px = 1 pt. */
export function renderPage(
  bytes: Uint8Array,
  page: number,
): Promise<RenderedPage> {
  return withPdf(bytes, async (dir, file) => {
    const out = join(dir, 'page');
    await run('pdftoppm', [
      '-f',
      String(page),
      '-l',
      String(page),
      '-r',
      '72',
      '-gray',
      '-cropbox',
      '-singlefile',
      file,
      out,
    ]);
    return parsePgm(await readFile(`${out}.pgm`));
  });
}

/** `pdffonts` output (stdout and stderr) for the whole document. */
export function pdffonts(
  bytes: Uint8Array,
): Promise<{ stdout: string; stderr: string }> {
  return withPdf(bytes, (_dir, file) => run('pdffonts', [file]));
}

/** `pdftotext` output for the whole document. */
export function pdftotext(bytes: Uint8Array): Promise<string> {
  return withPdf(
    bytes,
    async (_dir, file) => (await run('pdftotext', [file, '-'])).stdout,
  );
}

/**
 * Pixel rect of a user-space rect in a page rendered at 72 dpi, following the
 * page's visible box and `/Rotate` (applied clockwise, as viewers do).
 */
export function pixelRect(
  rect: { x: number; y: number; w: number; h: number },
  page: PageGeometry,
): { left: number; top: number; right: number; bottom: number } {
  const corners = [
    [rect.x, rect.y],
    [rect.x + rect.w, rect.y + rect.h],
  ].map(([px, py]) => {
    const dx = px - page.x;
    const dy = py - page.y;
    switch (page.rotate) {
      case 90:
        return [dy, dx];
      case 180:
        return [page.width - dx, dy];
      case 270:
        return [page.height - dy, page.width - dx];
      default:
        return [dx, page.height - dy];
    }
  });
  return {
    left: Math.min(corners[0][0], corners[1][0]),
    right: Math.max(corners[0][0], corners[1][0]),
    top: Math.min(corners[0][1], corners[1][1]),
    bottom: Math.max(corners[0][1], corners[1][1]),
  };
}

/** Number of dark pixels (value below 128) inside a pixel rect. */
export function inkIn(
  rendered: RenderedPage,
  rect: { left: number; top: number; right: number; bottom: number },
): number {
  let dark = 0;
  for (
    let y = Math.max(0, Math.floor(rect.top));
    y < Math.min(rendered.height, Math.ceil(rect.bottom));
    y += 1
  ) {
    for (
      let x = Math.max(0, Math.floor(rect.left));
      x < Math.min(rendered.width, Math.ceil(rect.right));
      x += 1
    ) {
      if (rendered.pixels[y * rendered.width + x] < 128) {
        dark += 1;
      }
    }
  }
  return dark;
}

/** Bounding box of the dark pixels inside a pixel rect, or null when there are none. */
export function inkBounds(
  rendered: RenderedPage,
  rect: { left: number; top: number; right: number; bottom: number },
): { width: number; height: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (
    let y = Math.max(0, Math.floor(rect.top));
    y < Math.min(rendered.height, Math.ceil(rect.bottom));
    y += 1
  ) {
    for (
      let x = Math.max(0, Math.floor(rect.left));
      x < Math.min(rendered.width, Math.ceil(rect.right));
      x += 1
    ) {
      if (rendered.pixels[y * rendered.width + x] < 128) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }
  return maxX < 0 ? null : { width: maxX - minX + 1, height: maxY - minY + 1 };
}
