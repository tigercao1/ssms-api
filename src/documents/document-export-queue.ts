import { Injectable, Logger } from '@nestjs/common';

/**
 * Runs bulk exports one at a time per process, separate from `PdfWorkQueue`
 * so a long export never delays signing. Jobs are accepted immediately and
 * wait their turn.
 */
@Injectable()
export class DocumentExportQueue {
  private readonly logger = new Logger(DocumentExportQueue.name);
  private tail: Promise<void> = Promise.resolve();
  private waiting = 0;

  /** Queues `job`; a failure is logged and does not stop later jobs. */
  enqueue(job: () => Promise<void>): void {
    this.waiting += 1;
    this.tail = this.tail.then(async () => {
      try {
        await job();
      } catch (err) {
        this.logger.error(
          `Export job failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        this.waiting -= 1;
      }
    });
  }

  /** Jobs queued or running. */
  get size(): number {
    return this.waiting;
  }

  /** Resolves once every job queued so far has settled. */
  idle(): Promise<void> {
    return this.tail;
  }
}
