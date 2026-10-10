import { Inject, Injectable, Logger } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import { BIO_TRANSLATOR } from './bio-translator.interface';
import type { BioLang, BioTranslator } from './bio-translator.interface';
import type { BioTranslationJobRow } from './bio-translation-job.types';

const BIO_JOBS_TABLE = 'bio_translation_jobs';
const AUDIT_TABLE = 'audit_log';
const BACKOFF_BASE_MS = 1_000;
const BIO_MAX_LENGTH = 1_000;

const HUMAN_TARGET = 'target bio was written by a human';

interface TargetState {
  text: string | null;
  machineTranslated: boolean;
}

function targetColumns(lang: BioLang) {
  return lang === 'en'
    ? { text: 'bio_en', flag: 'bio_en_machine_translated' }
    : { text: 'bio_zh', flag: 'bio_zh_machine_translated' };
}

function isWritable(target: TargetState): boolean {
  return (
    target.machineTranslated ||
    target.text === null ||
    target.text.trim() === ''
  );
}

/** Outcome of draining a single job (for tests / observability). */
export type WorkerOutcome =
  | 'idle' // nothing due
  | 'completed' // target field written + flag set
  | 'skipped' // stub returned '', or the target is human text — left as is
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
      const target = await this.loadTarget(job);
      if (!target || !isWritable(target)) {
        await this.markStatus(job.id, 'skipped', {
          last_error: target ? HUMAN_TARGET : 'instructor not found',
        });
        return 'skipped';
      }

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

      await this.applyTranslation(job, translated.trim(), target);
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

  private async loadTarget(
    job: BioTranslationJobRow,
  ): Promise<TargetState | null> {
    const columns = targetColumns(job.target_lang);
    const { data, error } = await this.supabase
      .from('instructors')
      .select(`${columns.text}, ${columns.flag}`)
      .eq('id', job.instructor_id)
      .maybeSingle();
    if (error) {
      throw new Error(`instructor read failed: ${error.message}`);
    }
    if (!data) {
      return null;
    }
    const row = data as unknown as Record<string, string | boolean | null>;
    return {
      text: (row[columns.text] as string | null) ?? null,
      machineTranslated: row[columns.flag] === true,
    };
  }

  /** Writes the translated text into the target bio + sets its MT flag and model. */
  private async applyTranslation(
    job: BioTranslationJobRow,
    translated: string,
    expected: TargetState,
  ): Promise<void> {
    if (translated.length > BIO_MAX_LENGTH) {
      throw new Error(
        `translation is ${translated.length} characters, over the ${BIO_MAX_LENGTH} limit`,
      );
    }
    const modelId = this.translator.modelId;
    const patch =
      job.target_lang === 'en'
        ? {
            bio_en: translated,
            bio_en_machine_translated: true,
            bio_en_translated_by: modelId,
          }
        : {
            bio_zh: translated,
            bio_zh_machine_translated: true,
            bio_zh_translated_by: modelId,
          };

    const columns = targetColumns(job.target_lang);
    const guardedUpdate = this.supabase
      .from('instructors')
      .update(patch)
      .eq('id', job.instructor_id)
      .eq(columns.flag, expected.machineTranslated);
    const { data, error } = await (
      expected.text === null
        ? guardedUpdate.is(columns.text, null)
        : guardedUpdate.eq(columns.text, expected.text)
    ).select('id');

    if (error) {
      throw new Error(`instructor update failed: ${error.message}`);
    }
    if (!data || data.length === 0) {
      throw new Error(`${columns.text} changed while translating`);
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
