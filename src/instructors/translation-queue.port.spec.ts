import { NoopTranslationQueue } from './translation-queue.port';

describe('NoopTranslationQueue', () => {
  it('reports no job enqueued and never throws', async () => {
    const queue = new NoopTranslationQueue();
    await expect(
      queue.enqueueForProfile({ instructorId: 'inst-1', bioEn: 'hi' }),
    ).resolves.toBe(false);
    await expect(
      queue.enqueueForProfile({ instructorId: 'inst-2', bioZh: '你好' }),
    ).resolves.toBe(false);
  });
});
