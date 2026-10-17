import { storageKeys } from './storage-keys';

describe('storageKeys', () => {
  it('builds the private bucket layout', () => {
    expect(storageKeys.templateSource('t')).toBe('templates/t/source.pdf');
    expect(storageKeys.templateUpload('t')).toBe('templates/t/upload.pdf');
    expect(storageKeys.templateTranslationSource('t', 'en')).toBe(
      'templates/t/translations/en/source.pdf',
    );
    expect(storageKeys.templateTranslationUpload('t', 'zh')).toBe(
      'templates/t/translations/zh/upload.pdf',
    );
    expect(storageKeys.instructorDocument('i', 'a')).toBe(
      'subjects/instructor/i/documents/a.pdf',
    );
    expect(storageKeys.instructorCertification('i', 'u', 'h', 'png')).toBe(
      'subjects/instructor/i/certifications/u-h.png',
    );
    expect(storageKeys.instructorCertificationStaging('i', 'u', 'png')).toBe(
      'subjects/instructor/i/certifications/staging/u.png',
    );
    expect(storageKeys.instructorCertificationIntent('i', 'u')).toBe(
      'subjects/instructor/i/certifications/u.intent.json',
    );
    expect(storageKeys.templateObjects('t')).toEqual([
      'templates/t/source.pdf',
      'templates/t/upload.pdf',
      'templates/t/translations/en/source.pdf',
      'templates/t/translations/en/upload.pdf',
      'templates/t/translations/zh/source.pdf',
      'templates/t/translations/zh/upload.pdf',
    ]);
    expect(storageKeys.customerDocument('c', 'a')).toBe(
      'subjects/customer/c/documents/a.pdf',
    );
  });
});
