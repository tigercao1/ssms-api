import { Module } from '@nestjs/common';
import {
  DocsStorageClient,
  HttpDocsStorageClient,
} from './docs-storage.client';
import { PublicPagesController } from './public-pages.controller';
import {
  PublicPagesRepository,
  SupabasePublicPagesRepository,
} from './public-pages.repository';
import { PublicPagesService } from './public-pages.service';

/**
 * PublicPagesModule — admin-managed public HTML pages under `/admin/pages`.
 * Page metadata lives in `public_pages`; the HTML itself is stored through the
 * docs Worker, bound behind {@link DocsStorageClient} so tests can swap a fake.
 */
@Module({
  controllers: [PublicPagesController],
  providers: [
    PublicPagesService,
    { provide: PublicPagesRepository, useClass: SupabasePublicPagesRepository },
    { provide: DocsStorageClient, useClass: HttpDocsStorageClient },
  ],
})
export class PublicPagesModule {}
