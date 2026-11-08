import { Injectable } from '@nestjs/common';
import { FormAdminRepository } from './form-admin.repository';
import type {
  SignatureCheck,
  Signer,
  StudentSignature,
} from './form-templates.types';
import { MeDocumentsService } from './me-documents.service';

export const SIGNER_LOOKUP_LIMIT = 25;
export const STUDENT_LOOKUP_LIMIT = 100;

@Injectable()
export class SignatureLookupsService {
  constructor(
    private readonly repo: FormAdminRepository,
    private readonly me: MeDocumentsService,
  ) {}

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

  async check(email: string): Promise<SignatureCheck> {
    const rows = await this.repo.signatureCheck(email);
    return {
      signed: rows.length > 0,
      signedAt: rows[0]?.signed_at ?? null,
      templateTitles: rows.map((row) => row.title_en),
    };
  }

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
