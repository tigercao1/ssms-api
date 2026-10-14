import {
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type {
  BioDraft,
  BioDraftInput,
  BioDraftMode,
  BioTranslator,
} from '../bio-translation/bio-translator.interface';
import {
  BioAiQuotaRepository,
  type BioAiReservation,
  type BioAiWindow,
} from './bio-ai-quota.repository';
import { BioDraftService, toUsage } from './bio-draft.service';
import type { InstructorsRepository } from './instructors.repository';
import type { InstructorRow } from './instructors.types';

const NOW = Date.parse('2026-10-14T03:00:00.000Z');
const HOUR = 60 * 60 * 1000;

/** In-memory quota that serialises reservations like the SQL advisory lock. */
class FakeQuota extends BioAiQuotaRepository {
  rows: { id: string; instructorId: string; mode: string; at: number }[] = [];
  released: string[] = [];
  releaseError: Error | null = null;
  private lock: Promise<unknown> = Promise.resolve();
  private seq = 0;

  usage(instructorId: string): Promise<BioAiWindow> {
    return Promise.resolve(this.window(instructorId));
  }

  reserve(
    instructorId: string,
    mode: BioDraftMode,
    limit: number,
  ): Promise<BioAiReservation> {
    const next = this.lock.then(async () => {
      await new Promise((resolve) => setImmediate(resolve));
      const window = this.window(instructorId);
      if (window.used >= limit) {
        return { requestId: null, ...window };
      }
      const id = `req-${++this.seq}`;
      this.rows.push({ id, instructorId, mode, at: Date.now() });
      return { requestId: id, ...this.window(instructorId) };
    });
    this.lock = next;
    return next;
  }

  release(requestId: string): Promise<void> {
    if (this.releaseError) {
      return Promise.reject(this.releaseError);
    }
    this.released.push(requestId);
    this.rows = this.rows.filter((r) => r.id !== requestId);
    return Promise.resolve();
  }

  private window(instructorId: string): BioAiWindow {
    const live = this.rows
      .filter((r) => r.instructorId === instructorId && r.at > NOW - 24 * HOUR)
      .map((r) => r.at)
      .sort((a, b) => a - b);
    return {
      used: live.length,
      oldestAt: live.length ? new Date(live[0]).toISOString() : null,
    };
  }
}

function makeTranslator(
  draft?: (input: BioDraftInput) => Promise<BioDraft>,
): BioTranslator & { draft?: jest.Mock } {
  return {
    modelId: 'gemini-test',
    translate: jest.fn(),
    draft: draft ? jest.fn(draft) : undefined,
  };
}

describe('toUsage', () => {
  it('reports no reset time when nothing is used', () => {
    expect(toUsage({ used: 0, oldestAt: null })).toEqual({
      limit: 5,
      used: 0,
      remaining: 5,
      resetsAt: null,
    });
  });

  it('resets when the oldest counted request leaves the 24 h window', () => {
    expect(
      toUsage({ used: 2, oldestAt: '2026-10-13T10:15:00.123+00:00' }),
    ).toEqual({
      limit: 5,
      used: 2,
      remaining: 3,
      resetsAt: '2026-10-14T10:15:00.123Z',
    });
  });

  it('never reports negative remaining requests', () => {
    expect(
      toUsage({ used: 7, oldestAt: '2026-10-13T10:15:00Z' }),
    ).toMatchObject({ used: 5, remaining: 0 });
  });
});

describe('BioDraftService', () => {
  let quota: FakeQuota;
  let instructors: Pick<InstructorsRepository, 'findByAuthUserId'>;

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW, doNotFake: ['setImmediate'] });
    quota = new FakeQuota();
    instructors = {
      findByAuthUserId: jest.fn((authUserId: string) =>
        Promise.resolve(
          authUserId === 'auth-1' ? ({ id: 'inst-1' } as InstructorRow) : null,
        ),
      ),
    };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const build = (translator: BioTranslator) =>
    new BioDraftService(
      instructors as InstructorsRepository,
      quota,
      translator,
    );

  const ok = () =>
    makeTranslator(() =>
      Promise.resolve({
        en: 'I teach skiing.',
        zh: '我教滑雪。',
        sourceLangs: ['en'],
      }),
    );

  it('returns usage for the caller', async () => {
    quota.rows.push({
      id: 'old',
      instructorId: 'inst-1',
      mode: 'refine',
      at: NOW - 2 * HOUR,
    });
    await expect(build(ok()).getUsage('auth-1')).resolves.toEqual({
      limit: 5,
      used: 1,
      remaining: 4,
      resetsAt: new Date(NOW + 22 * HOUR).toISOString(),
    });
  });

  it('404s when the caller has no profile', async () => {
    await expect(build(ok()).getUsage('ghost')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      build(ok()).draft('ghost', { text: 'Hi', mode: 'refine' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns both languages, the model and the usage after this call', async () => {
    const translator = ok();
    await expect(
      build(translator).draft('auth-1', {
        text: '  I teach skiing.  ',
        mode: 'translate',
      }),
    ).resolves.toEqual({
      en: 'I teach skiing.',
      zh: '我教滑雪。',
      sourceLangs: ['en'],
      model: 'gemini-test',
      usage: {
        limit: 5,
        used: 1,
        remaining: 4,
        resetsAt: new Date(NOW + 24 * HOUR).toISOString(),
      },
    });
    expect(translator.draft).toHaveBeenCalledWith({
      text: 'I teach skiing.',
      mode: 'translate',
      maxLength: 1000,
    });
    expect(quota.rows).toEqual([
      expect.objectContaining({ instructorId: 'inst-1', mode: 'translate' }),
    ]);
  });

  it('answers 429 bio_ai_limit with the usage once five are used', async () => {
    const translator = ok();
    const service = build(translator);
    for (let i = 0; i < 5; i++) {
      await service.draft('auth-1', { text: 'Hi', mode: 'refine' });
    }

    const err = await service
      .draft('auth-1', { text: 'Hi', mode: 'refine' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    expect((err as HttpException).getResponse()).toEqual({
      code: 'bio_ai_limit',
      usage: {
        limit: 5,
        used: 5,
        remaining: 0,
        resetsAt: new Date(NOW + 24 * HOUR).toISOString(),
      },
    });
    expect(translator.draft).toHaveBeenCalledTimes(5);
  });

  it('counts only requests inside the rolling window', async () => {
    for (let i = 0; i < 5; i++) {
      quota.rows.push({
        id: `old-${i}`,
        instructorId: 'inst-1',
        mode: 'refine',
        at: NOW - 25 * HOUR,
      });
    }
    await expect(
      build(ok()).draft('auth-1', { text: 'Hi', mode: 'refine' }),
    ).resolves.toMatchObject({ usage: { used: 1 } });
  });

  it('never lets concurrent requests exceed the limit', async () => {
    const translator = ok();
    const service = build(translator);

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        service.draft('auth-1', { text: 'Hi', mode: 'refine' }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const limited = results.filter(
      (r) =>
        r.status === 'rejected' &&
        (r.reason as HttpException).getStatus() === 429,
    );
    expect(fulfilled).toHaveLength(5);
    expect(limited).toHaveLength(3);
    expect(quota.rows).toHaveLength(5);
    expect(translator.draft).toHaveBeenCalledTimes(5);
  });

  it('answers 503 and releases the slot when Gemini fails', async () => {
    const translator = makeTranslator(() =>
      Promise.reject(new Error('Gemini HTTP 500')),
    );

    const err = await build(translator)
      .draft('auth-1', { text: 'Hi', mode: 'refine' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as HttpException).getResponse()).toEqual({
      code: 'bio_ai_unavailable',
    });
    expect(quota.released).toEqual(['req-1']);
    expect(quota.rows).toEqual([]);
    await expect(build(translator).getUsage('auth-1')).resolves.toMatchObject({
      used: 0,
      resetsAt: null,
    });
  });

  it('does not count failures toward the limit', async () => {
    let fail = true;
    const translator = makeTranslator(() =>
      fail
        ? Promise.reject(new Error('timeout'))
        : Promise.resolve({ en: 'a', zh: 'b', sourceLangs: ['en'] }),
    );
    const service = build(translator);
    for (let i = 0; i < 6; i++) {
      await service
        .draft('auth-1', { text: 'Hi', mode: 'refine' })
        .catch(() => undefined);
    }
    fail = false;
    await expect(
      service.draft('auth-1', { text: 'Hi', mode: 'refine' }),
    ).resolves.toMatchObject({ usage: { used: 1, remaining: 4 } });
  });

  it.each([[[]], [['fr']], [undefined]])(
    'answers 503 and releases the slot when sourceLangs is %j',
    async (sourceLangs) => {
      const translator = makeTranslator(() =>
        Promise.resolve({
          en: 'a',
          zh: 'b',
          sourceLangs: sourceLangs as unknown as BioDraft['sourceLangs'],
        }),
      );
      await expect(
        build(translator).draft('auth-1', { text: 'Hi', mode: 'refine' }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(quota.released).toEqual(['req-1']);
      expect(quota.rows).toEqual([]);
    },
  );

  it('returns mixed-input sourceLangs in canonical order', async () => {
    const translator = makeTranslator(() =>
      Promise.resolve({ en: 'a', zh: 'b', sourceLangs: ['zh-CN', 'en'] }),
    );
    await expect(
      build(translator).draft('auth-1', { text: 'Hi 你好', mode: 'translate' }),
    ).resolves.toMatchObject({ sourceLangs: ['en', 'zh-CN'] });
  });

  it('still answers 503 when the release itself fails', async () => {
    quota.releaseError = new Error('db down');
    const translator = makeTranslator(() => Promise.reject(new Error('boom')));
    await expect(
      build(translator).draft('auth-1', { text: 'Hi', mode: 'refine' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('answers 503 without reserving when translation is disabled', async () => {
    const stub: BioTranslator = { modelId: null, translate: jest.fn() };
    await expect(
      build(stub).draft('auth-1', { text: 'Hi', mode: 'refine' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(quota.rows).toEqual([]);
  });
});
