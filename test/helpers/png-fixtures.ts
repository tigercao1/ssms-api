import { deflateSync } from 'node:zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/**
 * An RGBA PNG of a dark zig-zag stroke on a transparent background, like a
 * drawn signature. `noise` fills the transparent pixels with random
 * near-invisible data to make the file large and incompressible.
 */
export function signaturePng(
  width = 300,
  height = 100,
  { noise = false }: { noise?: boolean } = {},
): Buffer {
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 4);
    for (let x = 0; x < width; x += 1) {
      const wave =
        height / 2 + (height / 3) * Math.sin((x / width) * 4 * Math.PI);
      const onStroke = Math.abs(y - wave) < Math.max(2, height / 25);
      const offset = 1 + x * 4;
      if (onStroke) {
        row.set([10, 20, 90, 255], offset);
      } else if (noise) {
        row.set(
          [
            Math.floor(Math.random() * 256),
            Math.floor(Math.random() * 256),
            Math.floor(Math.random() * 256),
            Math.floor(Math.random() * 2),
          ],
          offset,
        );
      }
    }
    rows.push(row);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    pngHeader(width, height),
    pngChunk('IDAT', deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export interface PngHeaderOptions {
  bitDepth?: number;
  colorType?: number;
  interlace?: number;
  animated?: boolean;
}

export function blankPng(
  width: number,
  height: number,
  {
    bitDepth = 8,
    colorType = 0,
    interlace = 0,
    animated = false,
  }: PngHeaderOptions = {},
): Buffer {
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType] ?? 1;
  const rowBytes = 1 + Math.ceil((width * channels * bitDepth) / 8);
  const header = pngHeader(width, height, { bitDepth, colorType, interlace });
  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(1000, 0);
  return Buffer.concat([
    PNG_SIGNATURE,
    header,
    ...(animated ? [pngChunk('acTL', actl)] : []),
    ...(colorType === 3 ? [pngChunk('PLTE', Buffer.alloc(3))] : []),
    pngChunk(
      'IDAT',
      deflateSync(Buffer.alloc(rowBytes * height), { level: 9 }),
    ),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export function pngHeader(
  width: number,
  height: number,
  { bitDepth = 8, colorType = 6, interlace = 0 }: PngHeaderOptions = {},
): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([bitDepth, colorType, 0, 0, interlace], 8);
  return pngChunk('IHDR', header);
}

export function pngChunks(png: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < png.length; ) {
    const end = offset + 12 + png.readUInt32BE(offset);
    chunks.push(png.subarray(offset, end));
    offset = end;
  }
  return chunks;
}

export function assemblePng(chunks: Buffer[]): Buffer {
  return Buffer.concat([PNG_SIGNATURE, ...chunks]);
}
