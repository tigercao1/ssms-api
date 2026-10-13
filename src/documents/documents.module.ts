import { Module } from '@nestjs/common';
import { AdminDocumentAssignmentsController } from './admin-document-assignments.controller';
import { AdminDocumentTemplatesController } from './admin-document-templates.controller';
import {
  DocumentAssignmentsRepository,
  SupabaseDocumentAssignmentsRepository,
} from './document-assignments.repository';
import { DocumentAssignmentsService } from './document-assignments.service';
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
import { MeDocumentsController } from './me-documents.controller';
import { MeDocumentsService } from './me-documents.service';
import { PdfWorkQueue } from './pdf-work-queue';
import {
  PrivateStorageClient,
  R2PrivateStorageClient,
} from './private-storage.client';

@Module({
  controllers: [
    AdminDocumentTemplatesController,
    AdminDocumentAssignmentsController,
    MeDocumentsController,
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
  ],
  exports: [
    PrivateStorageClient,
    DocumentTemplatesRepository,
    DocumentAssignmentsRepository,
    DocumentSubjectsRepository,
    PdfWorkQueue,
    DocumentAssignmentsService,
  ],
})
export class DocumentsModule {}
