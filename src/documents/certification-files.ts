import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';

export const MAX_CERTIFICATION_BYTES = 10 * 1024 * 1024;

/** Accepted certification file types and the extension each is stored under. */
export const CERTIFICATION_FILE_EXTENSIONS = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const;
export type CertificationContentType =
  keyof typeof CERTIFICATION_FILE_EXTENSIONS;
export const CERTIFICATION_CONTENT_TYPES = Object.keys(
  CERTIFICATION_FILE_EXTENSIONS,
) as CertificationContentType[];

const SNIFF_BYTES = 12;

const SIGNATURES: Record<CertificationContentType, (head: Buffer) => boolean> =
  {
    'application/pdf': (head) =>
      head.subarray(0, 5).toString('latin1') === '%PDF-',
    'image/jpeg': (head) =>
      head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff,
    'image/png': (head) =>
      head
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    'image/webp': (head) =>
      head.subarray(0, 4).toString('latin1') === 'RIFF' &&
      head.subarray(8, 12).toString('latin1') === 'WEBP',
  };

export function isCertificationContentType(
  value: unknown,
): value is CertificationContentType {
  return Object.hasOwn(CERTIFICATION_FILE_EXTENSIONS, value as string);
}

/** The media type of a `Content-Type` header value, lower-cased, without parameters. */
export function mediaType(contentType: string | null): string {
  return (contentType ?? '').split(';')[0].trim().toLowerCase();
}

/** Whether the file's leading bytes match the declared type. */
export function matchesSignature(
  contentType: CertificationContentType,
  head: Buffer,
): boolean {
  return SIGNATURES[contentType](head);
}

/** SHA-256, byte count and leading bytes of a stream, read once. */
export interface StreamDigest {
  sha256: string;
  sizeBytes: number;
  head: Buffer;
}

export async function digestStream(stream: Readable): Promise<StreamDigest> {
  const hash = createHash('sha256');
  const head: Buffer[] = [];
  let headBytes = 0;
  let sizeBytes = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk as Uint8Array);
    hash.update(bytes);
    sizeBytes += bytes.length;
    if (headBytes < SNIFF_BYTES) {
      head.push(bytes.subarray(0, SNIFF_BYTES - headBytes));
      headBytes += head[head.length - 1].length;
    }
  }
  return { sha256: hash.digest('hex'), sizeBytes, head: Buffer.concat(head) };
}
