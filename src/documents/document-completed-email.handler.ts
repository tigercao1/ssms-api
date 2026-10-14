import { Injectable, Logger } from '@nestjs/common';
import {
  DocumentCompletedHandler,
  type SignedDocument,
} from './document-completed.handler';
import { DocumentNotificationsService } from './document-notifications.service';

/**
 * Emails the signer their signed copy (`documents.completed`, PDF attached)
 * in the background, so the completion response never waits on Resend and a
 * failed send never undoes the completion.
 */
@Injectable()
export class DocumentCompletedEmailHandler extends DocumentCompletedHandler {
  private readonly logger = new Logger(DocumentCompletedEmailHandler.name);

  constructor(private readonly notifications: DocumentNotificationsService) {
    super();
  }

  documentCompleted({
    assignment,
    template,
    pdf,
    sha256,
  }: SignedDocument): Promise<void> {
    void this.notifications
      .sendCompleted(assignment, template, pdf, sha256)
      .catch((err: unknown) => {
        this.logger.error(
          `Signed-copy email failed for assignment ${assignment.id}: ${(err as Error).message}`,
        );
      });
    return Promise.resolve();
  }
}
