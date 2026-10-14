import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import { DocumentAssignmentsRepository } from './document-assignments.repository';
import { DocumentAssignmentsService } from './document-assignments.service';
import { DocumentCompletedEmailHandler } from './document-completed-email.handler';
import { DocumentCompletedHandler } from './document-completed.handler';
import { MeDocumentsService } from './me-documents.service';
import {
  PrivateStorageClient,
  R2PrivateStorageClient,
} from './private-storage.client';

describe('DocumentsModule in the app', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('boots without R2 credentials and wires the documents providers', async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const supabase = { from: jest.fn(), rpc: jest.fn() };
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SUPABASE_CLIENT)
      .useValue(supabase)
      .compile();
    await moduleRef.init();

    expect(moduleRef.get(PrivateStorageClient)).toBeInstanceOf(
      R2PrivateStorageClient,
    );
    expect(moduleRef.get(DocumentAssignmentsRepository)).toBeDefined();
    expect(moduleRef.get(DocumentAssignmentsService)).toBeInstanceOf(
      DocumentAssignmentsService,
    );
    expect(moduleRef.get(MeDocumentsService)).toBeInstanceOf(
      MeDocumentsService,
    );
    expect(moduleRef.get(DocumentCompletedHandler)).toBeInstanceOf(
      DocumentCompletedEmailHandler,
    );
    await moduleRef.close();
  });
});
