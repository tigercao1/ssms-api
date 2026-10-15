import { Injectable, Logger } from '@nestjs/common';
import { resolveEmailLanguage } from '../mailer/email-language';
import { MailerService } from '../mailer/mailer.service';
import type {
  EmailDocumentTitle,
  EmailLanguage,
  SendOutcome,
} from '../mailer/mailer.types';
import { DocumentSubjectsRepository } from './document-subjects.repository';
import type {
  DocumentAssignmentRow,
  DocumentInstructorRow,
  DocumentTemplateRow,
} from './documents.types';
import { PDF_CONTENT_TYPE } from './template-pdf';

export const ONBOARDING_PATH = '/onboarding';
const FILENAME_MAX_LENGTH = 80;

/** The template fields an email needs; satisfied by template rows and embedded templates. */
export type DocumentEmailTemplate = Pick<
  DocumentTemplateRow,
  'id' | 'title_en' | 'title_zh'
>;

/**
 * Onboarding document emails: `documents.assigned`, `documents.reminder` and
 * `documents.completed` (with the signed PDF attached). Every send uses the
 * mailer's background mode, so these methods never throw for a delivery
 * failure; they resolve to the outcome, or `null` when there is no recipient.
 */
@Injectable()
export class DocumentNotificationsService {
  private readonly logger = new Logger(DocumentNotificationsService.name);

  constructor(
    private readonly mailer: MailerService,
    private readonly subjects: DocumentSubjectsRepository,
  ) {}

  /**
   * Tells an instructor which documents were just assigned to them;
   * `approved` opens the email with their approval.
   */
  async sendAssigned(
    instructor: DocumentInstructorRow,
    templates: DocumentEmailTemplate[],
    season: string | null,
    { approved = false }: { approved?: boolean } = {},
  ): Promise<SendOutcome | null> {
    if (templates.length === 0) {
      return null;
    }
    return this.mailer.send({
      template: 'documents.assigned',
      to: instructor.email,
      language: resolveEmailLanguage(instructor.preferred_language),
      vars: { ...this.listVars(instructor, templates), approved },
      mode: 'background',
      instructorId: instructor.id,
      authUserId: instructor.auth_user_id,
      metadata: { templateIds: templates.map((t) => t.id), season, approved },
    });
  }

  /** Reminds an instructor of their open assignments (one email for all of them). */
  async sendReminder(
    instructor: DocumentInstructorRow,
    assignments: DocumentAssignmentRow[],
    idempotencyKey?: string,
  ): Promise<SendOutcome | null> {
    const templates = assignments
      .map((a) => a.template)
      .filter((t): t is NonNullable<typeof t> => t !== null);
    if (templates.length === 0) {
      return null;
    }
    return this.mailer.send({
      template: 'documents.reminder',
      to: instructor.email,
      language: resolveEmailLanguage(instructor.preferred_language),
      vars: this.listVars(instructor, templates),
      mode: 'background',
      instructorId: instructor.id,
      authUserId: instructor.auth_user_id,
      metadata: { assignmentIds: assignments.map((a) => a.id) },
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
  }

  /**
   * Emails the signer their signed copy as a PDF attachment, with its final
   * SHA-256 in the body. Instructors get it in their language with a portal
   * link, at the signer email recorded on the assignment (else their account
   * email). Customers get a bilingual email without a portal link, and
   * nothing when the assignment has no signer email.
   */
  async sendCompleted(
    assignment: DocumentAssignmentRow,
    template: DocumentEmailTemplate,
    pdf: Buffer,
    sha256: string,
  ): Promise<SendOutcome | null> {
    const recipient = await this.completedRecipient(assignment);
    if (!recipient) {
      this.logger.warn(
        `No recipient for the signed copy of assignment ${assignment.id}; not emailed.`,
      );
      return null;
    }
    const instructor = recipient.instructor;
    return this.mailer.send({
      template: 'documents.completed',
      to: recipient.email,
      language: recipient.language,
      vars: {
        displayName: assignment.signer_name ?? instructor?.display_name_en,
        document: emailTitle(template),
        sha256,
        onboardingUrl: instructor
          ? this.mailer.portalLink(ONBOARDING_PATH)
          : null,
      },
      mode: 'background',
      instructorId: instructor?.id ?? null,
      authUserId: instructor?.auth_user_id ?? null,
      metadata: {
        assignmentId: assignment.id,
        templateId: template.id,
        subjectType: assignment.subject_type,
        subjectId: assignment.subject_id,
        signedSha256: sha256,
      },
      idempotencyKey: `documents.completed/${assignment.id}`,
      attachments: [
        {
          filename: signedCopyFilename(template),
          content: pdf,
          contentType: PDF_CONTENT_TYPE,
        },
      ],
    });
  }

  private async completedRecipient(assignment: DocumentAssignmentRow): Promise<{
    email: string;
    language: EmailLanguage;
    instructor: DocumentInstructorRow | null;
  } | null> {
    const signerEmail = assignment.signer_email?.trim() || null;
    if (assignment.subject_type !== 'instructor') {
      return signerEmail
        ? { email: signerEmail, language: 'bilingual', instructor: null }
        : null;
    }
    const instructor = await this.subjects.findInstructor(
      assignment.subject_id,
    );
    const email = signerEmail ?? instructor?.email ?? null;
    if (!email) {
      return null;
    }
    return {
      email,
      language: resolveEmailLanguage(instructor?.preferred_language),
      instructor,
    };
  }

  private listVars(
    instructor: DocumentInstructorRow,
    templates: DocumentEmailTemplate[],
  ) {
    return {
      displayName: instructor.display_name_en,
      documents: templates.map(emailTitle),
      onboardingUrl: this.mailer.portalLink(ONBOARDING_PATH),
    };
  }
}

function emailTitle(template: DocumentEmailTemplate): EmailDocumentTitle {
  return { titleEn: template.title_en, titleZh: template.title_zh };
}

/** ASCII attachment name from the English title, e.g. `Instructor-agreement-signed.pdf`. */
export function signedCopyFilename(template: DocumentEmailTemplate): string {
  const base = template.title_en
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, FILENAME_MAX_LENGTH)
    .replace(/-+$/, '');
  return `${base || 'document'}-signed.pdf`;
}
