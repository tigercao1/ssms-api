import { Inject, Injectable, Logger } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import { BIO_TRANSLATOR } from './bio-translator.interface';
import type { BioTranslator } from './bio-translator.interface';
import type { BioTranslationJobRow } from './bio-translation-job.types';

const BIO_JOBS_TABLE = 'bio_translation_jobs';
const AUDIT_TABLE = 'audit_log';
const BACKOFF_BASE_MS = 1_000;

/** Outcome of draining a single job (for tests / observability). */
export type WorkerOutcome =
  | 'idle' // nothing due
  | 'completed' // target field written + flag set
  | 'skipped' // translator returned '' (stub / no provider) — left empty
  | 'retried' // transient failure, re-queued with backoff
  | 'failed'; // gave up after max_attempts

/**
 * Background drainer for the bio-translation queue (T5.2 scaffold).
 *
 * This is intentionally a plain, manually-invoked `processNext()` rather than a
 * cron binding: v1 has no scheduler dependency and the stub translator makes
 * every job a no-op. Post-v1, a real provider drops in via the {@link
 * BIO_TRANSLATOR} binding and a scheduler (or Supabase cron) calls
 * `processNext()` on an interval — no changes here.
 *
 * Failure policy (BIO_TRANSLATION_PLAN.md): exponential backoff, 3 attempts,
 * then give up and record `translation.failure` in `audit_log`.
 */
@Injectable()
export class TranslationWorkerService {
  private readonly logger = new Logger(TranslationWorkerService.name);

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    @Inject(BIO_TRANSLATOR) private readonly translator: BioTranslator,
  ) {}

  /**
   * Claims and processes the next due job, if any. Returns the outcome.
   * Safe to call repeatedly; returns `'idle'` when the queue is drained.
   */
  async processNext(): Promise<WorkerOutcome> {
    const job = await this.claimNextDueJob();
    if (!job) {
      return 'idle';
    }

    try {
      const translated = await this.translator.translate({
        text: job.source_text,
        from: job.source_lang,
        to: job.target_lang,
      });

      if (translated.trim().length === 0) {
        // Stub / no-provider path: leave the target empty, flag stays false.
        await this.markStatus(job.id, 'skipped');
        return 'skipped';
      }

      await this.applyTranslation(job, translated);
      await this.markStatus(job.id, 'completed');
      return 'completed';
    } catch (err) {
      return this.handleFailure(job, err as Error);
    }
  }

  /** Picks the oldest due job and flips it to `processing` (best-effort claim). */
  private async claimNextDueJob(): Promise<BioTranslationJobRow | null> {
    const result = await this.supabase
      .from(BIO_JOBS_TABLE)
      .select('*')
      .eq('status', 'pending')
      .lte('run_after', new Date().toISOString())
      .order('run_after', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (result.error) {
      this.logger.error(
        `Failed to poll translation queue: ${result.error.message}`,
      );
      return null;
    }
    if (!result.data) {
      return null;
    }

    const job = result.data as BioTranslationJobRow;
    const { error: claimError } = await this.supabase
      .from(BIO_JOBS_TABLE)
      .update({ status: 'processing', attempts: job.attempts + 1 })
      .eq('id', job.id)
      .eq('status', 'pending');

    if (claimError) {
      // Another worker likely grabbed it; treat as nothing-to-do this tick.
      return null;
    }

    return { ...job, status: 'processing', attempts: job.attempts + 1 };
  }

  /** Writes the translated text into the missing bio + sets its MT flag. */
  private async applyTranslation(
    job: BioTranslationJobRow,
    translated: string,
  ): Promise<void> {
    const patch =
      job.target_lang === 'en'
        ? { bio_en: translated, bio_en_machine_translated: true }
        : { bio_zh: translated, bio_zh_machine_translated: true };

    const { error } = await this.supabase
      .from('instructors')
      .update(patch)
      .eq('id', job.instructor_id);

    if (error) {
      throw new Error(`instructor update failed: ${error.message}`);
    }
  }

  private async markStatus(
    id: string,
    status: BioTranslationJobRow['status'],
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const { error } = await this.supabase
      .from(BIO_JOBS_TABLE)
      .update({ status, ...extra })
      .eq('id', id);
    if (error) {
      this.logger.error(
        `Failed to set job ${id} -> ${status}: ${error.message}`,
      );
    }
  }

  /** Re-queues with backoff, or gives up + audits after max_attempts. */
  private async handleFailure(
    job: BioTranslationJobRow,
    err: Error,
  ): Promise<WorkerOutcome> {
    if (job.attempts >= job.max_attempts) {
      await this.markStatus(job.id, 'failed', { last_error: err.message });
      await this.recordAuditFailure(job, err);
      this.logger.error(
        `Translation job ${job.id} gave up after ${job.attempts} attempts: ${err.message}`,
      );
      return 'failed';
    }

    const delayMs = BACKOFF_BASE_MS * 2 ** (job.attempts - 1);
    const runAfter = new Date(Date.now() + delayMs).toISOString();
    await this.markStatus(job.id, 'pending', {
      last_error: err.message,
      run_after: runAfter,
    });
    this.logger.warn(
      `Translation job ${job.id} attempt ${job.attempts} failed; retrying after ${delayMs}ms`,
    );
    return 'retried';
  }

  /** Logs a give-up to audit_log so admins can spot an unhealthy queue. */
  private async recordAuditFailure(
    job: BioTranslationJobRow,
    err: Error,
  ): Promise<void> {
    const { error } = await this.supabase.from(AUDIT_TABLE).insert({
      actor_role: 'system',
      action: 'translation.failure',
      target_type: 'instructor',
      target_id: job.instructor_id,
      metadata: {
        job_id: job.id,
        source_lang: job.source_lang,
        target_lang: job.target_lang,
        attempts: job.attempts,
        error: err.message,
      },
    });
    if (error) {
      this.logger.error(`Failed to write audit failure: ${error.message}`);
    }
  }
}
