import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ACTIONS, type AuditActor } from '../audit/audit.types';
import type { ImportJotformSignatureDto } from './dto/jotform-import.dto';
import { splitName } from './form-signing.service';
import { JotformImportsRepository } from './jotform-imports.repository';
import {
  JOTFORM_FORM_LANGUAGES,
  JOTFORM_WAIVER_SLUG,
  type ImportedSignatureRow,
  type JotformImportResult,
} from './jotform-imports.types';
import { PrivateStorageClient } from './private-storage.client';
import { storageKeys } from './storage-keys';
import { PDF_CONTENT_TYPE, sha256Hex } from './template-pdf';

export const JOTFORM_PDF_REQUIRED = 'Attach the Jotform PDF as `pdf`';
export const JOTFORM_PDF_INVALID = 'The `pdf` file is not a PDF';
export const JOTFORM_WAIVER_MISSING = `The "${JOTFORM_WAIVER_SLUG}" form does not exist`;

const PDF_MAGIC = Buffer.from('%PDF-', 'latin1');

export interface UploadedPdf {
  size: number;
  buffer: Buffer;
}

function existing(
  submissionId: string,
  row: ImportedSignatureRow,
): JotformImportResult {
  return {
    status: 'existing',
    submissionId,
    customerId: row.subject_id,
    assignmentId: row.id,
    signedSha256: row.signed_sha256,
  };
}

function answers(dto: ImportJotformSignatureDto): Record<string, string> {
  const values: Record<string, string | undefined> = {
    participantName: dto.participantName,
    email: dto.email,
    date: dto.typedDate,
    idNumber: dto.idNumber,
    guardianName: dto.guardianName,
    witnessName: dto.witnessName,
  };
  return Object.fromEntries(
    Object.entries(values).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

/** Files signed Jotform waivers as completed `waiver` signatures, keeping Jotform's PDF as the signed copy. */
@Injectable()
export class JotformImportsService {
  constructor(
    private readonly repo: JotformImportsRepository,
    private readonly storage: PrivateStorageClient,
    private readonly audit: AuditService,
  ) {}

  async import(
    dto: ImportJotformSignatureDto,
    pdf: UploadedPdf | undefined,
    actor: AuditActor,
  ): Promise<JotformImportResult> {
    if (!pdf || pdf.size === 0) {
      throw new BadRequestException(JOTFORM_PDF_REQUIRED);
    }
    if (!pdf.buffer.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
      throw new BadRequestException(JOTFORM_PDF_INVALID);
    }
    const found = await this.repo.findImported(dto.submissionId);
    if (found) {
      return existing(dto.submissionId, found);
    }
    const templateId = await this.repo.formTemplateId(JOTFORM_WAIVER_SLUG);
    if (!templateId) {
      throw new NotFoundException(JOTFORM_WAIVER_MISSING);
    }
    const customerId = await this.repo.customerForEmail(
      dto.email,
      ...splitName(dto.participantName),
    );
    const id = randomUUID();
    const key = storageKeys.customerDocument(customerId, id);
    const sha256 = sha256Hex(pdf.buffer);
    await this.storage.put(key, pdf.buffer, PDF_CONTENT_TYPE);
    let inserted: boolean;
    try {
      inserted = await this.repo.insertImported({
        id,
        template_id: templateId,
        subject_id: customerId,
        language: JOTFORM_FORM_LANGUAGES[dto.formId],
        signer_name: dto.participantName,
        signer_email: dto.email,
        signer_ip: dto.ip ?? null,
        completed_at: new Date(dto.submittedAt).toISOString(),
        signed_key: key,
        signed_sha256: sha256,
        field_values: answers(dto),
        external_id: dto.submissionId,
        external_form_id: dto.formId,
      });
    } catch (err) {
      await this.storage.delete(key).catch(() => undefined);
      throw err;
    }
    if (!inserted) {
      await this.storage.delete(key).catch(() => undefined);
      const raced = await this.repo.findImported(dto.submissionId);
      if (!raced) {
        throw new Error(
          `Jotform submission ${dto.submissionId} conflicted but is not imported`,
        );
      }
      return existing(dto.submissionId, raced);
    }
    await this.audit.record({
      action: AUDIT_ACTIONS.documentAssignmentImport,
      actor: { ...actor, role: 'admin' },
      targetType: 'document_assignment',
      targetId: id,
      metadata: {
        source: 'jotform',
        submissionId: dto.submissionId,
        formId: dto.formId,
        customerId,
        signedSha256: sha256,
      },
    });
    return {
      status: 'imported',
      submissionId: dto.submissionId,
      customerId,
      assignmentId: id,
      signedSha256: sha256,
    };
  }
}
