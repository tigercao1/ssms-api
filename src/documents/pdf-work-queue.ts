import { Injectable } from '@nestjs/common';

/**
 * Runs memory-heavy PDF jobs (loading, normalising, stamping) one at a time per
 * process, so concurrent requests cannot stack whole PDFs in memory at once.
 */
@Injectable()
export class PdfWorkQueue {
  private tail: Promise<unknown> = Promise.resolve();

  /** Runs `job` after every previously queued job has settled. */
  run<T>(job: () => Promise<T>): Promise<T> {
    const result = this.tail.then(job, job);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
