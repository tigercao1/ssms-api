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
