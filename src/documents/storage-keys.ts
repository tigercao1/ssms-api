/** Object keys in the private bucket. Every key is built here. */
export const storageKeys = {
  /** Normalised source PDF of a template (latest only). */
  templateSource: (templateId: string) => `templates/${templateId}/source.pdf`,
  /** Raw admin upload waiting for confirm; replaced by `templateSource` once validated. */
  templateUpload: (templateId: string) => `templates/${templateId}/upload.pdf`,
  /** Signed, flattened copy of an instructor's assignment. */
  instructorDocument: (instructorId: string, assignmentId: string) =>
    `subjects/instructor/${instructorId}/documents/${assignmentId}.pdf`,
  /** Uploaded certification proof. */
  instructorCertification: (
    instructorId: string,
    uploadId: string,
    extension: string,
  ) =>
    `subjects/instructor/${instructorId}/certifications/${uploadId}.${extension}`,
  /** What the instructor declared when asking for a certification upload URL, read back on confirm. */
  instructorCertificationIntent: (instructorId: string, uploadId: string) =>
    `subjects/instructor/${instructorId}/certifications/${uploadId}.intent.json`,
  /** Signed copy of a customer's assignment. */
  customerDocument: (customerId: string, assignmentId: string) =>
    `subjects/customer/${customerId}/documents/${assignmentId}.pdf`,
};
