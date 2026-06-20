import { Injectable } from '@nestjs/common';

/**
 * Port for enqueuing async bio translation. The real implementation lives in
 * the BioTranslation module (T5.2, owned by another agent) as
 * `TranslationQueueService.enqueueForProfile`. The Instructors module depends
 * only on this narrow, structurally-compatible interface so it can enqueue work
 * without a hard type dependency on that module (and so tests can bind a fake).
 *
 * InstructorsModule binds TRANSLATION_QUEUE to the real `TranslationQueueService`
 * (see instructors.module.ts).
 */
export const TRANSLATION_QUEUE = Symbol('TRANSLATION_QUEUE');

/** Bio fields handed to the queue after a profile save (mirrors BioSnapshot). */
export interface BioSnapshotInput {
  instructorId: string;
  bioEn?: string | null;
  bioZh?: string | null;
}

export interface TranslationQueuePort {
  /**
   * Enqueue a translation job for the just-saved profile. The queue itself
   * decides whether a job is warranted (exactly one bio language present) and
   * never throws into the caller — a queue hiccup must not fail the profile
   * save. Returns whether a job was enqueued.
   */
  enqueueForProfile(snapshot: BioSnapshotInput): Promise<boolean>;
}

/**
 * No-op fallback (used only if the real queue is unavailable, e.g. in isolated
 * tests). Records nothing and reports that no job was enqueued.
 */
@Injectable()
export class NoopTranslationQueue implements TranslationQueuePort {
  enqueueForProfile(): Promise<boolean> {
    return Promise.resolve(false);
  }
}
