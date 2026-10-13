import { storageKeys } from './storage-keys';

describe('storageKeys', () => {
  it('builds the private bucket layout', () => {
    expect(storageKeys.templateSource('t')).toBe('templates/t/source.pdf');
    expect(storageKeys.templateUpload('t')).toBe('templates/t/upload.pdf');
    expect(storageKeys.instructorDocument('i', 'a')).toBe(
      'subjects/instructor/i/documents/a.pdf',
    );
    expect(storageKeys.instructorCertification('i', 'u', 'png')).toBe(
      'subjects/instructor/i/certifications/u.png',
    );
    expect(storageKeys.customerDocument('c', 'a')).toBe(
      'subjects/customer/c/documents/a.pdf',
    );
  });
});
