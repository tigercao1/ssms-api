import { Injectable, Logger } from '@nestjs/common';
import { DocumentExportsRepository } from './document-exports.repository';
import type { DocumentExportRetentionResult } from './document-exports.types';
import { PrivateStorageClient } from './private-storage.client';

/** Deletes export ZIPs 24 hours after they were built; part of the daily job. */
@Injectable()
export class DocumentExportRetentionService {
  private readonly logger = new Logger(DocumentExportRetentionService.name);

  constructor(
    private readonly exports: DocumentExportsRepository,
    private readonly storage: PrivateStorageClient,
  ) {}

  /**
   * Deletes the object of every `ready` export past `expires_at` and marks it
   * `expired`. A failed delete leaves the export `ready`, so the next run
   * retries it.
   */
  async run(now: Date): Promise<DocumentExportRetentionResult> {
    let expired = 0;
    for (const row of await this.exports.listExpired(now.toISOString())) {
      try {
        if (row.zip_key) {
          await this.storage.delete(row.zip_key);
        }
        if (
          await this.exports.updateIfStatus(row.id, ['ready'], {
            status: 'expired',
          })
        ) {
          expired += 1;
        }
      } catch (err) {
        this.logger.error(
          `Expiring export ${row.id} failed: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    this.logger.log(`Document exports: ${expired} expired.`);
    return { expired };
  }
}
