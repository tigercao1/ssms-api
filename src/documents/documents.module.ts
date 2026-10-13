import { Module } from '@nestjs/common';
import { RolesGuard } from '../admin/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { MailerModule } from '../mailer/mailer.module';
import { AdminDocumentRemindersController } from './admin-document-reminders.controller';
import { AdminDocumentAssignmentsController } from './admin-document-assignments.controller';
import { AdminDocumentTemplatesController } from './admin-document-templates.controller';
import {
  DocumentAssignmentsRepository,
  SupabaseDocumentAssignmentsRepository,
} from './document-assignments.repository';
import { DocumentAssignmentsService } from './document-assignments.service';
import { DocumentNotificationsService } from './document-notifications.service';
import { DocumentOnboardingService } from './document-onboarding.service';
import { DocumentRemindersAuthGuard } from './document-reminders-auth.guard';
import { DocumentRemindersService } from './document-reminders.service';
import { DocumentSigningService } from './document-signing.service';
import {
  DocumentSubjectsRepository,
  SupabaseDocumentSubjectsRepository,
} from './document-subjects.repository';
import {
  DocumentTemplatesRepository,
  SupabaseDocumentTemplatesRepository,
} from './document-templates.repository';
import { DocumentTemplatesService } from './document-templates.service';
import { InternalDocumentsController } from './internal-documents.controller';
import { MeDocumentsController } from './me-documents.controller';
import { MeDocumentsService } from './me-documents.service';
import { PdfWorkQueue } from './pdf-work-queue';
import {
  PrivateStorageClient,
  R2PrivateStorageClient,
} from './private-storage.client';

@Module({
  imports: [MailerModule],
  controllers: [
    AdminDocumentTemplatesController,
    AdminDocumentAssignmentsController,
    MeDocumentsController,
    AdminDocumentRemindersController,
    InternalDocumentsController,
  ],
  providers: [
    { provide: PrivateStorageClient, useClass: R2PrivateStorageClient },
    {
      provide: DocumentTemplatesRepository,
      useClass: SupabaseDocumentTemplatesRepository,
    },
    {
      provide: DocumentAssignmentsRepository,
      useClass: SupabaseDocumentAssignmentsRepository,
    },
    {
      provide: DocumentSubjectsRepository,
      useClass: SupabaseDocumentSubjectsRepository,
    },
    PdfWorkQueue,
    DocumentTemplatesService,
    DocumentAssignmentsService,
    MeDocumentsService,
    DocumentSigningService,
    DocumentNotificationsService,
    DocumentOnboardingService,
    DocumentRemindersService,
    DocumentRemindersAuthGuard,
    SupabaseAuthGuard,
    RolesGuard,
  ],
  exports: [
    PrivateStorageClient,
    DocumentTemplatesRepository,
    DocumentAssignmentsRepository,
    DocumentSubjectsRepository,
    PdfWorkQueue,
    DocumentAssignmentsService,
    DocumentNotificationsService,
    DocumentOnboardingService,
  ],
})
export class DocumentsModule {}
