import { Module } from '@nestjs/common';
import { RolesGuard } from '../admin/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { MailerModule } from '../mailer/mailer.module';
import { SeasonsModule } from '../seasons/seasons.module';
import { AdminCertificationUploadsController } from './admin-certification-uploads.controller';
import { AdminCertificationUploadsService } from './admin-certification-uploads.service';
import { AdminDocumentReviewsController } from './admin-document-reviews.controller';
import { AdminDocumentReviewsService } from './admin-document-reviews.service';
import { AdminDocumentRemindersController } from './admin-document-reminders.controller';
import { AdminDocumentAssignmentsController } from './admin-document-assignments.controller';
import { AdminDocumentExportsController } from './admin-document-exports.controller';
import { AdminDocumentTemplatesController } from './admin-document-templates.controller';
import {
  AdminFormsController,
  AdminSignaturesController,
} from './admin-forms.controller';
import { AdminFormsService } from './admin-forms.service';
import { CertificationExpiryService } from './certification-expiry.service';
import {
  CertificationUploadsRepository,
  SupabaseCertificationUploadsRepository,
} from './certification-uploads.repository';
import {
  DocumentAssignmentsRepository,
  SupabaseDocumentAssignmentsRepository,
} from './document-assignments.repository';
import { DocumentAssignmentsService } from './document-assignments.service';
import { DocumentCompletedEmailHandler } from './document-completed-email.handler';
import { DocumentCompletedHandler } from './document-completed.handler';
import { DocumentExportOwner } from './document-export-owner';
import { DocumentExportQueue } from './document-export-queue';
import { DocumentExportRetentionService } from './document-export-retention.service';
import {
  DocumentExportsRepository,
  SupabaseDocumentExportsRepository,
} from './document-exports.repository';
import { DocumentExportsService } from './document-exports.service';
import { DocumentOnboardingService } from './document-onboarding.service';
import { DocumentPublishingService } from './document-publishing.service';
import { DocumentRemindersAuthGuard } from './document-reminders-auth.guard';
import { DocumentRemindersService } from './document-reminders.service';
import { DocumentSigningService } from './document-signing.service';
import {
  DocumentTemplatesRepository,
  SupabaseDocumentTemplatesRepository,
} from './document-templates.repository';
import { DocumentTemplatesService } from './document-templates.service';
import { DocumentsCoreModule } from './documents-core.module';
import {
  FormAdminRepository,
  SupabaseFormAdminRepository,
} from './form-admin.repository';
import { FormSigningModule } from './form-signing.module';
import { InternalDocumentsController } from './internal-documents.controller';
import { MeCertificationUploadsController } from './me-certification-uploads.controller';
import { MeCertificationUploadsService } from './me-certification-uploads.service';
import { MeDocumentsController } from './me-documents.controller';
import { MeDocumentsService } from './me-documents.service';
import { MeEmploymentLetterController } from './me-employment-letter.controller';
import { MeStudentSignaturesController } from './me-student-signatures.controller';
import { EmploymentLetterService } from './employment-letter.service';
import { SignFormsThrottlerGuard } from './sign-forms-throttler.guard';
import { SignatureLookupsService } from './signature-lookups.service';

@Module({
  imports: [
    MailerModule,
    SeasonsModule,
    DocumentsCoreModule,
    FormSigningModule,
  ],
  controllers: [
    AdminDocumentTemplatesController,
    AdminDocumentAssignmentsController,
    AdminDocumentExportsController,
    MeDocumentsController,
    MeEmploymentLetterController,
    AdminDocumentRemindersController,
    InternalDocumentsController,
    MeCertificationUploadsController,
    AdminCertificationUploadsController,
    AdminDocumentReviewsController,
    AdminFormsController,
    AdminSignaturesController,
    MeStudentSignaturesController,
  ],
  providers: [
    {
      provide: DocumentTemplatesRepository,
      useClass: SupabaseDocumentTemplatesRepository,
    },
    {
      provide: DocumentAssignmentsRepository,
      useClass: SupabaseDocumentAssignmentsRepository,
    },
    {
      provide: DocumentExportsRepository,
      useClass: SupabaseDocumentExportsRepository,
    },
    DocumentExportQueue,
    DocumentExportOwner,
    DocumentExportsService,
    DocumentExportRetentionService,
    DocumentTemplatesService,
    DocumentPublishingService,
    DocumentAssignmentsService,
    MeDocumentsService,
    EmploymentLetterService,
    DocumentSigningService,
    {
      provide: DocumentCompletedHandler,
      useClass: DocumentCompletedEmailHandler,
    },
    DocumentOnboardingService,
    DocumentRemindersService,
    DocumentRemindersAuthGuard,
    SupabaseAuthGuard,
    RolesGuard,
    {
      provide: CertificationUploadsRepository,
      useClass: SupabaseCertificationUploadsRepository,
    },
    MeCertificationUploadsService,
    AdminCertificationUploadsService,
    AdminDocumentReviewsService,
    CertificationExpiryService,
    { provide: FormAdminRepository, useClass: SupabaseFormAdminRepository },
    AdminFormsService,
    SignatureLookupsService,
    SignFormsThrottlerGuard,
  ],
  exports: [
    DocumentsCoreModule,
    DocumentTemplatesRepository,
    DocumentAssignmentsRepository,
    DocumentAssignmentsService,
    MeDocumentsService,
    DocumentOnboardingService,
    CertificationExpiryService,
    DocumentRemindersService,
    DocumentExportRetentionService,
  ],
})
export class DocumentsModule {}
