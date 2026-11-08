import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DocumentNotificationsService } from './document-notifications.service';
import {
  SIGNING_CONSENT,
  type SigningEvidence,
} from './document-signing.service';
import type {
  DocumentAssignmentRow,
  DocumentLanguage,
} from './documents.types';
import type { CompleteFormDto } from './dto/complete-form.dto';
import { type FormAnswers, parseFormAnswers } from './form-answers';
import { renderFormPdf } from './form-pdf';
import { FormSigningRepository } from './form-signing.repository';
import type {
  CompletedForm,
  PublicForm,
  PublishedForm,
} from './form-templates.types';
import { PdfWorkQueue } from './pdf-work-queue';
import { PrivateStorageClient } from './private-storage.client';
import { SigningInputError } from './signing-input';
import { storageKeys } from './storage-keys';
import { PDF_CONTENT_TYPE, sha256Hex } from './template-pdf';

export const FORM_NOT_FOUND = 'Form not found';
export const FORM_VERSION_STALE =
  'This form has changed since it was opened; reload it and sign again';
export const FORM_CONSENT_REQUIRED =
  'Agree to sign electronically to submit this form';

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const USER_AGENT_MAX_LENGTH = 512;
const ANSWERS_HEADING: Record<DocumentLanguage, string> = {
  en: 'Answers',
  zh: '填写内容',
};

interface SignedForm {
  assignment: DocumentAssignmentRow;
  pdf: Buffer;
  sha256: string;
}

function splitName(full: string): [string, string | null] {
  const at = full.lastIndexOf(' ');
  return at > 0 ? [full.slice(0, at), full.slice(at + 1)] : [full, null];
}

@Injectable()
export class FormSigningService {
  private readonly logger = new Logger(FormSigningService.name);

  constructor(
    private readonly forms: FormSigningRepository,
    private readonly storage: PrivateStorageClient,
    private readonly pdfQueue: PdfWorkQueue,
    private readonly notifications: DocumentNotificationsService,
  ) {}

  async get(slug: string, lang: DocumentLanguage): Promise<PublicForm> {
    const other: DocumentLanguage = lang === 'en' ? 'zh' : 'en';
    const form =
      (await this.published(slug, lang)) ?? (await this.published(slug, other));
    if (!form) {
      throw new NotFoundException(FORM_NOT_FOUND);
    }
    const { version } = form;
    return {
      slug: form.slug,
      lang: version.language,
      version: version.version,
      title: version.title,
      bodyMarkdown: version.body_markdown,
      fields: version.fields,
    };
  }

  async complete(
    slug: string,
    dto: CompleteFormDto,
    evidence: SigningEvidence,
    now = new Date(),
  ): Promise<CompletedForm> {
    const form = await this.published(slug, dto.lang);
    if (!form) {
      throw new NotFoundException(FORM_NOT_FOUND);
    }
    if (dto.version !== form.version.version) {
      throw new ConflictException(FORM_VERSION_STALE);
    }
    if (dto.consent !== true) {
      throw new BadRequestException(FORM_CONSENT_REQUIRED);
    }
    const answers = this.parse(form, dto);
    const customerId = await this.forms.customerForEmail(
      answers.signerEmail,
      ...splitName(answers.signerName),
    );
    const signed = await this.pdfQueue.run(() =>
      this.signAndStore(form, customerId, answers, evidence, now),
    );
    return {
      status: 'signed',
      emailed: await this.email(form, signed, answers.signerEmail),
    };
  }

  private published(
    slug: string,
    lang: DocumentLanguage,
  ): Promise<PublishedForm | null> {
    return SLUG.test(slug)
      ? this.forms.findPublished(slug, lang)
      : Promise.resolve(null);
  }

  private parse(form: PublishedForm, dto: CompleteFormDto): FormAnswers {
    try {
      return parseFormAnswers(
        form.version.fields,
        dto.answers,
        dto.signatures ?? {},
      );
    } catch (err) {
      if (err instanceof SigningInputError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
  }

  private async signAndStore(
    form: PublishedForm,
    customerId: string,
    answers: FormAnswers,
    evidence: SigningEvidence,
    now: Date,
  ): Promise<SignedForm> {
    const { version } = form;
    const bodySha256 = sha256Hex(Buffer.from(version.body_markdown, 'utf8'));
    if (bodySha256 !== version.body_sha256) {
      this.logger.warn(
        `Form ${form.templateId} v${version.version} (${version.language}) text hash ${bodySha256} differs from the recorded ${version.body_sha256}`,
      );
    }
    const id = randomUUID();
    const signedAt = now.toISOString();
    const userAgent =
      evidence.userAgent?.slice(0, USER_AGENT_MAX_LENGTH) ?? null;
    const stamped = await renderFormPdf({
      title: version.title,
      bodyMarkdown: version.body_markdown,
      fields: version.fields,
      values: answers.values,
      signatures: answers.signatures,
      answersHeading: ANSWERS_HEADING[version.language],
      audit: {
        titleEn: form.titleEn,
        titleZh: form.titleZh,
        templateSha256: bodySha256,
        assignmentId: id,
        signerName: answers.signerName,
        signerEmail: answers.signerEmail,
        consentEn: SIGNING_CONSENT.en,
        consentZh: SIGNING_CONSENT.zh,
        ip: evidence.ip,
        userAgent,
        viewedAt: null,
        signedAt,
        linkEvidence: `${form.slug}, version ${version.version}`,
        language: version.language,
      },
    });
    const key = storageKeys.customerDocument(customerId, id);
    await this.storage.put(key, stamped.bytes, PDF_CONTENT_TYPE);
    let assignment: DocumentAssignmentRow;
    try {
      assignment = await this.forms.insertSigned({
        id,
        template_id: form.templateId,
        subject_id: customerId,
        form_version: version.version,
        language: version.language,
        signer_name: answers.signerName,
        signer_email: answers.signerEmail,
        signer_ip: evidence.ip,
        signer_user_agent: userAgent,
        consent_at: signedAt,
        completed_at: signedAt,
        template_sha256: bodySha256,
        signed_key: key,
        signed_sha256: stamped.sha256,
        field_values: answers.values,
      });
    } catch (err) {
      await this.storage.delete(key).catch(() => undefined);
      throw err;
    }
    return {
      assignment,
      pdf: Buffer.from(
        stamped.bytes.buffer,
        stamped.bytes.byteOffset,
        stamped.bytes.byteLength,
      ),
      sha256: stamped.sha256,
    };
  }

  private async email(
    form: PublishedForm,
    { assignment, pdf, sha256 }: SignedForm,
    signerEmail: string,
  ): Promise<boolean> {
    try {
      const emailHash = sha256Hex(
        Buffer.from(signerEmail.toLowerCase(), 'utf8'),
      );
      if (!(await this.forms.claimCopyEmail(emailHash))) {
        this.logger.warn(
          `Signed-copy email limit reached; not emailing form assignment ${assignment.id}`,
        );
        return false;
      }
      const outcome = await this.notifications.sendCompleted(
        assignment,
        {
          id: form.templateId,
          title_en: form.titleEn,
          title_zh: form.titleZh,
          kind: 'sign',
        },
        pdf,
        sha256,
      );
      return outcome === 'sent';
    } catch (err) {
      this.logger.error(
        `Signed-copy email failed for form assignment ${assignment.id}: ${(err as Error).message}`,
      );
      return false;
    }
  }
}
