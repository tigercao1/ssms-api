import { TranslationWorkerService } from './translation-worker.service';
import { StubBioTranslator } from './stub-bio-translator';
import type { BioTranslator } from './bio-translator.interface';
import type { BioTranslationJobRow } from './bio-translation-job.types';

function jobRow(
  over: Partial<BioTranslationJobRow> = {},
): BioTranslationJobRow {
  return {
    id: 'job-1',
    instructor_id: 'instr-1',
    source_lang: 'en',
    target_lang: 'zh-CN',
    source_text: 'I teach skiing.',
    status: 'pending',
    attempts: 0,
    max_attempts: 3,
    last_error: null,
    run_after: new Date(0).toISOString(),
    inserted_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    ...over,
  };
}

/** Minimal Supabase fake that hands back one due job then drains. */
function makeSupabase(job: BioTranslationJobRow | null) {
  const updates: Array<Record<string, unknown>> = [];
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];

  const from = jest.fn((table: string) => {
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: () => builder,
      lte: () => builder,
      order: () => builder,
      limit: () => builder,
      in: () => builder,
      maybeSingle: () => Promise.resolve({ data: job, error: null }),
      update: (patch: Record<string, unknown>) => {
        updates.push(patch);
        return { eq: () => ({ eq: () => Promise.resolve({ error: null }) }) };
      },
      insert: (row: Record<string, unknown>) => {
        inserts.push({ table, row });
        return Promise.resolve({ error: null });
      },
    };
    return builder;
  });

  return { client: { from } as never, updates, inserts };
}

describe('TranslationWorkerService', () => {
  it('returns idle when no job is due', async () => {
    const { client } = makeSupabase(null);
    const worker = new TranslationWorkerService(
      client,
      new StubBioTranslator(),
    );
    expect(await worker.processNext()).toBe('idle');
  });

  it('skips (leaves field empty, no MT flag) when the stub returns ""', async () => {
    const { client, updates } = makeSupabase(jobRow());
    const worker = new TranslationWorkerService(
      client,
      new StubBioTranslator(),
    );

    expect(await worker.processNext()).toBe('skipped');

    // No update ever set a machine_translated flag to true.
    const setMtFlag = updates.some(
      (u) =>
        u.bio_en_machine_translated === true ||
        u.bio_zh_machine_translated === true,
    );
    expect(setMtFlag).toBe(false);
    expect(updates).toContainEqual(
      expect.objectContaining({ status: 'skipped' }),
    );
  });

  it('completes and sets the MT flag when a real provider returns text', async () => {
    const { client, updates } = makeSupabase(jobRow());
    const realProvider: BioTranslator = {
      translate: () => Promise.resolve('我教滑雪。'),
    };
    const worker = new TranslationWorkerService(client, realProvider);

    expect(await worker.processNext()).toBe('completed');
    expect(updates).toContainEqual(
      expect.objectContaining({
        bio_zh: '我教滑雪。',
        bio_zh_machine_translated: true,
      }),
    );
  });
});
