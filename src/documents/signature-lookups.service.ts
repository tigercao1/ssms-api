import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ACTIONS, type AuditActor } from '../audit/audit.types';
import type { CustomerRow } from '../customers/customers.repository';
import { CustomersRepository } from '../customers/customers.repository';
import { FormAdminRepository } from './form-admin.repository';
import type {
  SignatureCheck,
  SignedDocumentEntry,
  SignedDocumentRow,
  Signer,
  StudentSignature,
} from './form-templates.types';
import { MeDocumentsService } from './me-documents.service';
import { signedThisWaiverYear, waiverFor } from './waiver-year';

export const SIGNER_LOOKUP_LIMIT = 25;
export const STUDENT_LOOKUP_LIMIT = 100;
export const SIGNATURE_NOT_FOUND = 'Signature not found';
export const SIGNATURE_NOT_LINKABLE =
  'Only a completed customer signature can be linked to a customer';
export const LINK_CUSTOMER_NOT_FOUND = 'Customer not found';
export const SIGNATURE_CHANGED =
  'This signature was changed by someone else; reload it and try again';

function toEntry(
  row: SignedDocumentRow,
  now: Date,
): SignedDocumentEntry | null {
  if (!row.assignment_id || !row.template_id || !row.signed_at) {
    return null;
  }
  return {
    assignmentId: row.assignment_id,
    templateId: row.template_id,
    titleEn: row.title_en ?? '',
    titleZh: row.title_zh,
    kind: row.kind ?? 'sign',
    language: row.language,
    formVersion: row.form_version,
    signedAt: row.signed_at,
    hasSignedCopy: row.has_signed_copy ?? false,
    validThisYear: signedThisWaiverYear(row.signed_at, now),
  };
}

function customerName(row: CustomerRow): string | null {
  return (
    [row.first_name, row.last_name].filter(Boolean).join(' ').trim() || null
  );
}

@Injectable()
export class SignatureLookupsService {
  constructor(
    private readonly repo: FormAdminRepository,
    private readonly customers: CustomersRepository,
    private readonly me: MeDocumentsService,
    private readonly audit: AuditService,
  ) {}

  async lookup(query: string): Promise<Signer[]> {
    const now = new Date();
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
          customerId: row.subject_type === 'customer' ? row.subject_id : null,
          name: row.name,
          email: row.email,
          waiver: null,
          signatures: [],
        };
        signers.set(key, signer);
      }
      const entry = toEntry(row, now);
      if (entry) {
        signer.signatures.push(entry);
      }
    }
    const people = [...signers.values()];
    const latest = await this.customers.latestSignatures(
      people.flatMap((p) => (p.customerId ? [p.customerId] : [])),
    );
    for (const person of people) {
      if (person.customerId) {
        person.waiver = waiverFor(latest.get(person.customerId) ?? null, now);
      }
    }
    return people;
  }

  async check(email: string): Promise<SignatureCheck> {
    const rows = await this.repo.signatureCheck(email);
    const waiver = waiverFor(rows[0]?.signed_at ?? null);
    return {
      signed: waiver.status === 'signed',
      status: waiver.status,
      year: waiver.year,
      signedAt: waiver.signedAt,
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
    const now = new Date();
    return rows.map((row) => {
      const { status } = waiverFor(row.signed_at, now);
      return {
        name: row.name,
        signed: status === 'signed',
        status,
        signedAt: row.signed_at,
      };
    });
  }

  async linkToCustomer(
    assignmentId: string,
    customerId: string,
    actor: AuditActor,
  ): Promise<Signer> {
    const signature = await this.repo.findSignatureSubject(assignmentId);
    if (!signature) {
      throw new NotFoundException(SIGNATURE_NOT_FOUND);
    }
    if (
      signature.subject_type !== 'customer' ||
      signature.status !== 'completed'
    ) {
      throw new BadRequestException(SIGNATURE_NOT_LINKABLE);
    }
    const customer = await this.customers.findById(customerId);
    if (!customer) {
      throw new NotFoundException(LINK_CUSTOMER_NOT_FOUND);
    }
    if (signature.subject_id !== customer.id) {
      const linked = await this.repo.relinkCustomerSignature(
        assignmentId,
        signature.subject_id,
        customer.id,
      );
      if (!linked) {
        throw new ConflictException(SIGNATURE_CHANGED);
      }
      await this.audit.record({
        action: AUDIT_ACTIONS.documentAssignmentLinkCustomer,
        actor: { ...actor, role: 'admin' },
        targetType: 'document_assignment',
        targetId: assignmentId,
        metadata: {
          fromCustomerId: signature.subject_id,
          toCustomerId: customer.id,
        },
      });
    }
    return this.customerSigner(customer);
  }

  private async customerSigner(customer: CustomerRow): Promise<Signer> {
    const [rows, latest] = await Promise.all([
      this.repo.customerSignatures(customer.id),
      this.customers.latestSignatures([customer.id]),
    ]);
    const now = new Date();
    return {
      subjectType: 'customer',
      subjectId: customer.id,
      customerId: customer.id,
      name: customerName(customer),
      email: customer.email,
      waiver: waiverFor(latest.get(customer.id) ?? null, now),
      signatures: rows.flatMap((row) => toEntry(row, now) ?? []),
    };
  }
}
