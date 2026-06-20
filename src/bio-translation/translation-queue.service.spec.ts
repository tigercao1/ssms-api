import {
  TranslationQueueService,
  planTranslationJob,
} from './translation-queue.service';

describe('planTranslationJob', () => {
  const id = 'instr-1';

  it('enqueues en->zh when only bio_en is filled', () => {
    expect(
      planTranslationJob({ instructorId: id, bioEn: 'Hello', bioZh: '' }),
    ).toEqual({
      instructorId: id,
      sourceLang: 'en',
      targetLang: 'zh-CN',
      sourceText: 'Hello',
    });
  });

  it('enqueues zh->en when only bio_zh is filled', () => {
    expect(
      planTranslationJob({ instructorId: id, bioEn: null, bioZh: '你好' }),
    ).toEqual({
      instructorId: id,
      sourceLang: 'zh-CN',
      targetLang: 'en',
      sourceText: '你好',
    });
  });

  it('does nothing when both are filled', () => {
    expect(
      planTranslationJob({ instructorId: id, bioEn: 'Hi', bioZh: '你好' }),
    ).toBeNull();
  });

  it('does nothing when both are empty', () => {
    expect(
      planTranslationJob({ instructorId: id, bioEn: '   ', bioZh: null }),
    ).toBeNull();
  });
});

describe('TranslationQueueService.enqueueForProfile', () => {
  function makeSupabase() {
    const deleteEq = jest.fn().mockReturnThis();
    const deleteIn = jest.fn().mockResolvedValue({ error: null });
    const insert = jest.fn().mockResolvedValue({ error: null });

    const from = jest.fn((table: string) => {
      void table;
      return {
        delete: () => ({ eq: deleteEq, in: deleteIn }),
        insert,
      };
    });
    // chain delete().eq().in()
    deleteEq.mockImplementation(() => ({ in: deleteIn }));

    return { client: { from } as never, from, insert, deleteIn };
  }

  it('enqueues a job when exactly one bio is filled and returns true', async () => {
    const { client, insert } = makeSupabase();
    const service = new TranslationQueueService(client);

    const enqueued = await service.enqueueForProfile({
      instructorId: 'instr-1',
      bioEn: 'I teach skiing.',
      bioZh: '',
    });

    expect(enqueued).toBe(true);
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        instructor_id: 'instr-1',
        source_lang: 'en',
        target_lang: 'zh-CN',
        source_text: 'I teach skiing.',
      }),
    );
  });

  it('does not enqueue (or touch the DB) when both bios are filled', async () => {
    const { client, from } = makeSupabase();
    const service = new TranslationQueueService(client);

    const enqueued = await service.enqueueForProfile({
      instructorId: 'instr-1',
      bioEn: 'Hi',
      bioZh: '你好',
    });

    expect(enqueued).toBe(false);
    expect(from).not.toHaveBeenCalled();
  });

  it('never throws and returns false if the insert errors', async () => {
    const { client, insert } = makeSupabase();
    insert.mockResolvedValue({ error: { message: 'boom' } });
    const service = new TranslationQueueService(client);

    await expect(
      service.enqueueForProfile({
        instructorId: 'instr-1',
        bioEn: 'Hello',
        bioZh: null,
      }),
    ).resolves.toBe(false);
  });
});
