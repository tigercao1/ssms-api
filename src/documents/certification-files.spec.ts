import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  CERTIFICATION_CONTENT_TYPES,
  digestStream,
  isCertificationContentType,
  matchesSignature,
  mediaType,
} from './certification-files';
import { FILE_SAMPLES } from '../../test/helpers/certification-fakes';

describe('certification files', () => {
  it('accepts exactly pdf, jpeg, png and webp', () => {
    expect(CERTIFICATION_CONTENT_TYPES).toEqual([
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/webp',
    ]);
    expect(isCertificationContentType('image/png')).toBe(true);
    expect(isCertificationContentType('image/gif')).toBe(false);
    expect(isCertificationContentType('toString')).toBe(false);
  });

  it('normalises media types', () => {
    expect(mediaType('Image/PNG; charset=binary')).toBe('image/png');
    expect(mediaType(null)).toBe('');
  });

  it.each(CERTIFICATION_CONTENT_TYPES)(
    'recognises a %s signature and rejects the others',
    (type) => {
      for (const [other, bytes] of Object.entries(FILE_SAMPLES)) {
        expect(matchesSignature(type, bytes)).toBe(other === type);
      }
    },
  );

  it('hashes and sizes a chunked stream and keeps the leading bytes', async () => {
    const body = Buffer.concat([
      FILE_SAMPLES['image/png'],
      Buffer.alloc(5000, 7),
    ]);
    const chunks = [body.subarray(0, 3), body.subarray(3, 9), body.subarray(9)];
    const digest = await digestStream(Readable.from(chunks));
    expect(digest.sha256).toBe(createHash('sha256').update(body).digest('hex'));
    expect(digest.sizeBytes).toBe(body.length);
    expect(digest.head).toEqual(body.subarray(0, 12));
  });

  it('digests an empty stream', async () => {
    const digest = await digestStream(Readable.from([]));
    expect(digest.sizeBytes).toBe(0);
    expect(digest.head.length).toBe(0);
  });
});
