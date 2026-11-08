import { Module } from '@nestjs/common';
import { MailerCoreModule } from '../mailer/mailer-core.module';
import { DocumentNotificationsService } from './document-notifications.service';
import {
  DocumentSubjectsRepository,
  SupabaseDocumentSubjectsRepository,
} from './document-subjects.repository';
import { PdfWorkQueue } from './pdf-work-queue';
import {
  PrivateStorageClient,
  R2PrivateStorageClient,
} from './private-storage.client';

@Module({
  imports: [MailerCoreModule],
  providers: [
    { provide: PrivateStorageClient, useClass: R2PrivateStorageClient },
    {
      provide: DocumentSubjectsRepository,
      useClass: SupabaseDocumentSubjectsRepository,
    },
    PdfWorkQueue,
    DocumentNotificationsService,
  ],
  exports: [
    PrivateStorageClient,
    DocumentSubjectsRepository,
    PdfWorkQueue,
    DocumentNotificationsService,
  ],
})
export class DocumentsCoreModule {}
