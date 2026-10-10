import {
  TranslationQueueService,
  planTranslationJob,
} from './translation-queue.service';
import type { BioChange, BioState } from './bio-translation-job.types';

const id = 'instr-1';

function state(over: Partial<BioState> = {}): BioState {
  return {
    bioEn: null,
    bioZh: null,
    bioEnMachineTranslated: false,
    bioZhMachineTranslated: false,
    ...over,
  };
}

function change(
  before: Partial<BioState>,
  after: Partial<BioState>,
): BioChange {
  return { instructorId: id, before: state(before), after: state(after) };
}

const EN_TO_ZH = {
  instructorId: id,
  sourceLang: 'en',
  targetLang: 'zh-CN',
};
const ZH_TO_EN = {
  instructorId: id,
  sourceLang: 'zh-CN',
  targetLang: 'en',
};

describe('planTranslationJob (two-way rule)', () => {
  it.each([
    [
      'human en, zh empty',
      change({}, { bioEn: 'Hello' }),
      { ...EN_TO_ZH, sourceText: 'Hello' },
    ],
    [
      'human zh, en empty',
      change({}, { bioZh: '你好' }),
      { ...ZH_TO_EN, sourceText: '你好' },
    ],
    [
      'human en, zh machine-translated',
      change(
        { bioEn: 'Old', bioZh: '旧', bioZhMachineTranslated: true },
        { bioEn: ' New ', bioZh: '旧', bioZhMachineTranslated: true },
      ),
      { ...EN_TO_ZH, sourceText: 'New' },
    ],
    [
      'human zh, en machine-translated',
      change(
        { bioEn: 'Old', bioZh: '旧', bioEnMachineTranslated: true },
        { bioEn: 'Old', bioZh: '新', bioEnMachineTranslated: true },
      ),
      { ...ZH_TO_EN, sourceText: '新' },
    ],
    [
      'human en, zh blank',
      change({ bioZh: '  ' }, { bioEn: 'Hi', bioZh: '  ' }),
      { ...EN_TO_ZH, sourceText: 'Hi' },
    ],
  ])('enqueues when %s', (_label, input, expected) => {
    expect(planTranslationJob(input)).toEqual(expected);
  });

  it.each([
    [
      'the target holds human text',
      change(
        { bioEn: 'Old', bioZh: '人写的' },
        { bioEn: 'New', bioZh: '人写的' },
      ),
    ],
    [
      'both languages were edited by a human in the same save',
      change(
        { bioEn: 'Old', bioZh: '旧', bioZhMachineTranslated: true },
        { bioEn: 'New', bioZh: '新' },
      ),
    ],
    [
      'both languages were filled for the first time',
      change({}, { bioEn: 'Hi', bioZh: '你好' }),
    ],
    ['nothing changed', change({ bioEn: 'Same' }, { bioEn: 'Same' })],
    [
      'only whitespace changed',
      change({ bioEn: 'Same' }, { bioEn: ' Same  ' }),
    ],
    [
      'the source was cleared',
      change(
        { bioEn: 'Old', bioZh: '旧', bioZhMachineTranslated: true },
        { bioEn: '', bioZh: '旧', bioZhMachineTranslated: true },
      ),
    ],
    [
      'the only change is a machine translation',
      change(
        { bioEn: 'Hi' },
        { bioEn: 'Hi', bioZh: '你好', bioZhMachineTranslated: true },
      ),
    ],
    ['both are empty', change({}, { bioEn: '   ', bioZh: null })],
  ])('does nothing when %s', (_label, input) => {
    expect(planTranslationJob(input)).toBeNull();
  });
});

describe('TranslationQueueService.enqueueForProfile', () => {
  function makeSupabase() {
    const deleteFilters: Array<[string, unknown]> = [];
    const deleteIn = jest.fn().mockResolvedValue({ error: null });
    const insert = jest.fn().mockResolvedValue({ error: null });
    const deleteChain = {
      eq: (column: string, value: unknown) => {
        deleteFilters.push([column, value]);
        return deleteChain;
      },
      in: deleteIn,
    };
    const from = jest.fn((table: string) => {
      void table;
      return { delete: () => deleteChain, insert };
    });

    return {
      client: { from } as never,
      from,
      insert,
      deleteIn,
      deleteFilters,
    };
  }

  it('supersedes outstanding jobs for the same instructor and direction, then enqueues', async () => {
    const { client, insert, deleteIn, deleteFilters } = makeSupabase();
    const service = new TranslationQueueService(client);

    const enqueued = await service.enqueueForProfile(
      change({}, { bioEn: 'I teach skiing.' }),
    );

    expect(enqueued).toBe(true);
    expect(deleteFilters).toEqual([
      ['instructor_id', 'instr-1'],
      ['target_lang', 'zh-CN'],
    ]);
    expect(deleteIn).toHaveBeenCalledWith('status', ['pending', 'processing']);
    expect(insert).toHaveBeenCalledWith({
      instructor_id: 'instr-1',
      source_lang: 'en',
      target_lang: 'zh-CN',
      source_text: 'I teach skiing.',
    });
    expect(deleteIn.mock.invocationCallOrder[0]).toBeLessThan(
      insert.mock.invocationCallOrder[0],
    );
  });

  it('does not touch the DB when the plan is empty', async () => {
    const { client, from } = makeSupabase();
    const service = new TranslationQueueService(client);

    const enqueued = await service.enqueueForProfile(
      change({}, { bioEn: 'Hi', bioZh: '你好' }),
    );

    expect(enqueued).toBe(false);
    expect(from).not.toHaveBeenCalled();
  });

  it('never throws and returns false if the insert errors', async () => {
    const { client, insert } = makeSupabase();
    insert.mockResolvedValue({ error: { message: 'boom' } });
    const service = new TranslationQueueService(client);

    await expect(
      service.enqueueForProfile(change({}, { bioEn: 'Hello' })),
    ).resolves.toBe(false);
  });

  it('never throws and returns false if superseding errors', async () => {
    const { client, deleteIn, insert } = makeSupabase();
    deleteIn.mockResolvedValue({ error: { message: 'boom' } });
    const service = new TranslationQueueService(client);

    await expect(
      service.enqueueForProfile(change({}, { bioZh: '你好' })),
    ).resolves.toBe(false);
    expect(insert).not.toHaveBeenCalled();
  });
});
