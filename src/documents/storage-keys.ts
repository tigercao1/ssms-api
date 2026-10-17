import type { DocumentLanguage } from './documents.types';

/** Object keys in the private bucket. Every key is built here. */
export const storageKeys = {
  /** Normalised source PDF of a template (latest only). */
  templateSource: (templateId: string) => `templates/${templateId}/source.pdf`,
  /** Raw admin upload waiting for confirm; replaced by `templateSource` once validated. */
  templateUpload: (templateId: string) => `templates/${templateId}/upload.pdf`,
  templateTranslationSource: (templateId: string, language: DocumentLanguage) =>
    `templates/${templateId}/translations/${language}/source.pdf`,
  templateTranslationUpload: (templateId: string, language: DocumentLanguage) =>
    `templates/${templateId}/translations/${language}/upload.pdf`,
  /** Signed, flattened copy of an instructor's assignment. */
  instructorDocument: (instructorId: string, assignmentId: string) =>
    `subjects/instructor/${instructorId}/documents/${assignmentId}.pdf`,
  /** Confirmed certification proof, written by the API from checked bytes and never presigned for upload. */
  instructorCertification: (
    instructorId: string,
    uploadId: string,
    sha256: string,
    extension: string,
  ) =>
    `subjects/instructor/${instructorId}/certifications/${uploadId}-${sha256}.${extension}`,
  /** Raw instructor upload behind the presigned PUT, copied to `instructorCertification` on confirm. */
  instructorCertificationStaging: (
    instructorId: string,
    uploadId: string,
    extension: string,
  ) =>
    `subjects/instructor/${instructorId}/certifications/staging/${uploadId}.${extension}`,
  /** What the instructor declared when asking for a certification upload URL, read back on confirm. */
  instructorCertificationIntent: (instructorId: string, uploadId: string) =>
    `subjects/instructor/${instructorId}/certifications/${uploadId}.intent.json`,
  /** Signed copy of a customer's assignment. */
  customerDocument: (customerId: string, assignmentId: string) =>
    `subjects/customer/${customerId}/documents/${assignmentId}.pdf`,
};
