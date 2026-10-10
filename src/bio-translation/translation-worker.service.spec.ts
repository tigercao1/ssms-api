import { ConfigService } from '@nestjs/config';
import {
  TRANSLATION_BATCH_SIZE,
  TRANSLATION_POLL_INTERVAL_MS,
  TranslationWorkerService,
} from './translation-worker.service';
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

interface Instructor {
  bio_en: string | null;
  bio_zh: string | null;
  bio_en_machine_translated: boolean;
  bio_zh_machine_translated: boolean;
  [column: string]: unknown;
}

function instructor(over: Partial<Instructor> = {}): Instructor {
  return {
    bio_en: 'I teach skiing.',
    bio_zh: null,
    bio_en_machine_translated: false,
    bio_zh_machine_translated: false,
    ...over,
  };
}

interface Options {
  job: BioTranslationJobRow | null;
  claimWon?: boolean;
  instructor?: Instructor | null;
  beforeInstructorUpdate?: (row: Instructor) => void;
}

function makeSupabase({
  job,
  claimWon = true,
  instructor: row = instructor(),
  beforeInstructorUpdate,
}: Options) {
  const jobUpdates: Array<Record<string, unknown>> = [];
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];

  function jobsBuilder() {
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: () => builder,
      lte: () => builder,
      order: () => builder,
      limit: () => builder,
      maybeSingle: () => Promise.resolve({ data: job, error: null }),
      update: (patch: Record<string, unknown>) => {
        jobUpdates.push(patch);
        let selected = false;
        const chain = {
          eq: () => chain,
          select: () => {
            selected = true;
            return chain;
          },
          then: (resolve: (v: unknown) => void) =>
            resolve(
              selected
                ? { data: claimWon ? [{ id: 'job-1' }] : [], error: null }
                : { error: null },
            ),
        };
        return chain;
      },
    };
    return builder;
  }

  function instructorsBuilder() {
    const filters: Array<(r: Instructor) => boolean> = [];
    let patch: Record<string, unknown> | null = null;
    const builder: Record<string, unknown> = {
      select: () => builder,
      update: (p: Record<string, unknown>) => {
        patch = p;
        return builder;
      },
      eq: (column: string, value: unknown) => {
        if (column !== 'id') filters.push((r) => r[column] === value);
        return builder;
      },
      is: (column: string, value: unknown) => {
        filters.push((r) => r[column] === value);
        return builder;
      },
      maybeSingle: () => Promise.resolve({ data: row, error: null }),
      then: (resolve: (v: unknown) => void) => {
        if (row && patch) {
          beforeInstructorUpdate?.(row);
          if (filters.every((f) => f(row))) {
            Object.assign(row, patch);
            return resolve({ data: [{ id: 'instr-1' }], error: null });
          }
        }
        return resolve({ data: [], error: null });
      },
    };
    return builder;
  }

  const from = jest.fn((table: string) => {
    if (table === 'instructors') return instructorsBuilder();
    if (table === 'bio_translation_jobs') return jobsBuilder();
    return {
      insert: (r: Record<string, unknown>) => {
        inserts.push({ table, row: r });
        return Promise.resolve({ error: null });
      },
    };
  });

  return {
    client: { from } as never,
    jobUpdates,
    inserts,
    row: row as Instructor,
  };
}

function makeWorker(
  client: never,
  translator: BioTranslator,
  env: Record<string, string> = {},
) {
  return new TranslationWorkerService(
    client,
    translator,
    new ConfigService(env),
  );
}

function provider(result: string | Error = '我教滑雪。') {
  const translate = jest.fn(() =>
    result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
  );
  const translator: BioTranslator = { modelId: 'gemini-test', translate };
  return { translator, translate };
}

describe('TranslationWorkerService', () => {
  it('returns idle when no job is due', async () => {
    const { client } = makeSupabase({ job: null });
    const worker = makeWorker(client, new StubBioTranslator());
    expect(await worker.processNext()).toBe('idle');
  });

  it('skips (leaves field empty, no MT flag) when the stub returns ""', async () => {
    const { client, jobUpdates, row } = makeSupabase({ job: jobRow() });
    const worker = makeWorker(client, new StubBioTranslator());

    expect(await worker.processNext()).toBe('skipped');
    expect(row.bio_zh).toBeNull();
    expect(row.bio_zh_machine_translated).toBe(false);
    expect(jobUpdates).toContainEqual(
      expect.objectContaining({ status: 'skipped' }),
    );
  });

  it('writes the translation with the MT flag and model id into an empty target', async () => {
    const { client, jobUpdates, row } = makeSupabase({ job: jobRow() });
    const { translator, translate } = provider();
    const worker = makeWorker(client, translator);

    expect(await worker.processNext()).toBe('completed');
    expect(translate).toHaveBeenCalledWith({
      text: 'I teach skiing.',
      from: 'en',
      to: 'zh-CN',
    });
    expect(row).toEqual(
      expect.objectContaining({
        bio_zh: '我教滑雪。',
        bio_zh_machine_translated: true,
        bio_zh_translated_by: 'gemini-test',
      }),
    );
    expect(jobUpdates).toContainEqual({ status: 'completed' });
  });

  it('replaces an earlier machine translation in the target', async () => {
    const { client, row } = makeSupabase({
      job: jobRow({ source_lang: 'zh-CN', target_lang: 'en' }),
      instructor: instructor({
        bio_en: 'Old machine text',
        bio_en_machine_translated: true,
        bio_zh: '我教滑雪。',
      }),
    });
    const worker = makeWorker(client, provider('I teach skiing.').translator);

    expect(await worker.processNext()).toBe('completed');
    expect(row).toEqual(
      expect.objectContaining({
        bio_en: 'I teach skiing.',
        bio_en_machine_translated: true,
        bio_en_translated_by: 'gemini-test',
      }),
    );
  });

  it('never overwrites human text in the target and does not call the provider', async () => {
    const { client, row, jobUpdates } = makeSupabase({
      job: jobRow(),
      instructor: instructor({ bio_zh: '人写的简介' }),
    });
    const { translator, translate } = provider();
    const worker = makeWorker(client, translator);

    expect(await worker.processNext()).toBe('skipped');
    expect(translate).not.toHaveBeenCalled();
    expect(row.bio_zh).toBe('人写的简介');
    expect(jobUpdates).toContainEqual(
      expect.objectContaining({
        status: 'skipped',
        last_error: 'target bio was written by a human',
      }),
    );
  });

  it('skips a job whose instructor no longer exists', async () => {
    const { client } = makeSupabase({ job: jobRow(), instructor: null });
    const worker = makeWorker(client, provider().translator);

    expect(await worker.processNext()).toBe('skipped');
  });

  it('does not overwrite a human edit made while translating; it retries instead', async () => {
    const { client, row, jobUpdates } = makeSupabase({
      job: jobRow(),
      beforeInstructorUpdate: (r) => {
        r.bio_zh = '刚刚人写的';
      },
    });
    const worker = makeWorker(client, provider().translator);

    expect(await worker.processNext()).toBe('retried');
    expect(row.bio_zh).toBe('刚刚人写的');
    expect(row.bio_zh_machine_translated).toBe(false);
    expect(jobUpdates).toContainEqual(
      expect.objectContaining({
        status: 'pending',
        last_error: 'bio_zh changed while translating',
      }),
    );
  });

  it('does not write a translation longer than the bio limit', async () => {
    const { client, row, jobUpdates } = makeSupabase({ job: jobRow() });
    const worker = makeWorker(client, provider('长'.repeat(1001)).translator);

    expect(await worker.processNext()).toBe('retried');
    expect(row.bio_zh).toBeNull();
    expect(jobUpdates).toContainEqual(
      expect.objectContaining({
        last_error: 'translation is 1001 characters, over the 1000 limit',
      }),
    );
  });

  it('retries a provider failure with backoff', async () => {
    const { client, jobUpdates } = makeSupabase({ job: jobRow() });
    const worker = makeWorker(
      client,
      provider(new Error('Gemini HTTP 503')).translator,
    );

    expect(await worker.processNext()).toBe('retried');
    expect(jobUpdates).toContainEqual(
      expect.objectContaining({
        status: 'pending',
        last_error: 'Gemini HTTP 503',
        run_after: expect.any(String) as string,
      }),
    );
  });

  it('gives up after max_attempts and audits the failure', async () => {
    const { client, jobUpdates, inserts } = makeSupabase({
      job: jobRow({ attempts: 2, max_attempts: 3 }),
    });
    const worker = makeWorker(
      client,
      provider(new Error('Gemini returned no text')).translator,
    );

    expect(await worker.processNext()).toBe('failed');
    expect(jobUpdates).toContainEqual(
      expect.objectContaining({
        status: 'failed',
        last_error: 'Gemini returned no text',
      }),
    );
    expect(inserts).toContainEqual({
      table: 'audit_log',
      row: expect.objectContaining({
        action: 'translation.failure',
        target_id: 'instr-1',
      }) as Record<string, unknown>,
    });
  });

  it('skips a job another worker claimed first', async () => {
    const { client } = makeSupabase({ job: jobRow(), claimWon: false });
    const { translator, translate } = provider();

    expect(await makeWorker(client, translator).processNext()).toBe('idle');
    expect(translate).not.toHaveBeenCalled();
  });
});

describe('TranslationWorkerService polling', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function stubbedWorker(env: Record<string, string>) {
    const worker = makeWorker(
      makeSupabase({ job: null }).client,
      provider().translator,
      env,
    );
    const processNext = jest.spyOn(worker, 'processNext');
    return { worker, processNext };
  }

  it.each([
    [{}],
    [{ TRANSLATION_ENABLED: 'false' }],
    [{ TRANSLATION_ENABLED: 'TRUE' }],
  ])('does not poll unless TRANSLATION_ENABLED is "true" (%j)', async (env) => {
    const { worker, processNext } = stubbedWorker(env);
    processNext.mockResolvedValue('idle');

    worker.onModuleInit();
    await jest.advanceTimersByTimeAsync(TRANSLATION_POLL_INTERVAL_MS * 3);

    expect(worker.isEnabled()).toBe(false);
    expect(processNext).not.toHaveBeenCalled();
    await worker.onModuleDestroy();
  });

  it('polls every interval when enabled and stops on destroy', async () => {
    const { worker, processNext } = stubbedWorker({
      TRANSLATION_ENABLED: 'true',
    });
    processNext.mockResolvedValue('idle');

    worker.onModuleInit();
    expect(processNext).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(TRANSLATION_POLL_INTERVAL_MS);
    expect(processNext).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(TRANSLATION_POLL_INTERVAL_MS);
    expect(processNext).toHaveBeenCalledTimes(2);

    await worker.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(TRANSLATION_POLL_INTERVAL_MS * 3);
    expect(processNext).toHaveBeenCalledTimes(2);
  });

  it('drains due jobs each tick until idle', async () => {
    const { worker, processNext } = stubbedWorker({});
    processNext
      .mockResolvedValueOnce('completed')
      .mockResolvedValueOnce('retried')
      .mockResolvedValueOnce('idle');

    await expect(worker.tick()).resolves.toBe(2);
    expect(processNext).toHaveBeenCalledTimes(3);
  });

  it('bounds one tick to a batch', async () => {
    const { worker, processNext } = stubbedWorker({});
    processNext.mockResolvedValue('completed');

    await expect(worker.tick()).resolves.toBe(TRANSLATION_BATCH_SIZE);
  });

  it('does not overlap ticks', async () => {
    const { worker, processNext } = stubbedWorker({});
    let release!: () => void;
    processNext.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve('idle');
        }),
    );

    const first = worker.tick();
    const second = worker.tick();
    expect(second).toBe(first);
    release();
    await expect(first).resolves.toBe(0);
    expect(processNext).toHaveBeenCalledTimes(1);
  });

  it('stops the tick when polling throws', async () => {
    const { worker, processNext } = stubbedWorker({});
    processNext.mockRejectedValue(new Error('db down'));

    await expect(worker.tick()).resolves.toBe(0);
  });
});
