import { Injectable } from '@nestjs/common';
import { FormAdminRepository } from './form-admin.repository';
import type { Signer, StudentSignature } from './form-templates.types';
import { MeDocumentsService } from './me-documents.service';

export const SIGNER_LOOKUP_LIMIT = 25;
export const STUDENT_LOOKUP_LIMIT = 100;

/**
 * Who signed what: the admin search across instructors and customers, and an
 * instructor's view of their own students' waivers (name and date only).
 */
@Injectable()
export class SignatureLookupsService {
  constructor(
    private readonly repo: FormAdminRepository,
    private readonly me: MeDocumentsService,
  ) {}

  /** `GET /admin/signatures?q=`: at most {@link SIGNER_LOOKUP_LIMIT} instructors and as many customers. */
  async lookup(query: string): Promise<Signer[]> {
    const signers = new Map<string, Signer>();
    for (const row of await this.repo.lookupSignatures(
      query,
      SIGNER_LOOKUP_LIMIT,
    )) {
      const key = `${row.subject_type}:${row.subject_id}`;
      let signer = signers.get(key);
      if (!signer) {
        signer = {
          subjectType: row.subject_type,
          subjectId: row.subject_id,
          name: row.name,
          email: row.email,
          signatures: [],
        };
        signers.set(key, signer);
      }
      if (row.assignment_id && row.template_id && row.signed_at) {
        signer.signatures.push({
          assignmentId: row.assignment_id,
          templateId: row.template_id,
          titleEn: row.title_en ?? '',
          titleZh: row.title_zh,
          kind: row.kind ?? 'sign',
          language: row.language,
          formVersion: row.form_version,
          signedAt: row.signed_at,
          hasSignedCopy: row.has_signed_copy ?? false,
        });
      }
    }
    return [...signers.values()];
  }

  /** `GET /me/students/signatures?q=`: participants of the caller's classes. */
  async students(authUserId: string, query = ''): Promise<StudentSignature[]> {
    const instructor = await this.me.approvedInstructorFor(authUserId);
    const rows = await this.repo.studentSignatures(
      instructor.id,
      query,
      STUDENT_LOOKUP_LIMIT,
    );
    return rows.map((row) => ({
      name: row.name,
      signed: row.signed_at !== null,
      signedAt: row.signed_at,
    }));
  }
}
