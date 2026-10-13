import {
  CERTIFICATION_CONTENT_TYPES,
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
});
