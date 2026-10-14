import { createHash } from 'node:crypto';
import { MAX_ATTACHMENT_BYTES, type EmailAttachment } from './mailer.types';

/** What `email_log.metadata.attachments` records about each attached file. */
export interface AttachmentLogEntry {
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
}

/** Thrown when an email's attachments exceed {@link MAX_ATTACHMENT_BYTES}. */
export class AttachmentsTooLargeError extends Error {
  constructor(readonly totalBytes: number) {
    super(
      `Email attachments total ${totalBytes} bytes, over the ` +
        `${MAX_ATTACHMENT_BYTES}-byte limit`,
    );
    this.name = 'AttachmentsTooLargeError';
  }
}

/** Throws {@link AttachmentsTooLargeError} when the raw total is over the cap. */
export function assertAttachmentsWithinLimit(
  attachments: readonly EmailAttachment[] | undefined,
): void {
  const total = (attachments ?? []).reduce(
    (sum, attachment) => sum + attachment.content.length,
    0,
  );
  if (total > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentsTooLargeError(total);
  }
}

/** Filename, type, size and SHA-256 of each attachment, for the email log. */
export function describeAttachments(
  attachments: readonly EmailAttachment[],
): AttachmentLogEntry[] {
  return attachments.map((attachment) => ({
    filename: attachment.filename,
    contentType: attachment.contentType,
    sizeBytes: attachment.content.length,
    sha256: createHash('sha256').update(attachment.content).digest('hex'),
  }));
}
