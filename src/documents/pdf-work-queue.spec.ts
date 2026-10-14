import { PdfWorkQueue } from './pdf-work-queue';

describe('PdfWorkQueue', () => {
  it('runs jobs one at a time, in order, and survives failures', async () => {
    const queue = new PdfWorkQueue();
    const events: string[] = [];
    let release!: () => void;
    const first = queue.run(
      () =>
        new Promise<string>((resolve) => {
          events.push('first:start');
          release = () => {
            events.push('first:end');
            resolve('a');
          };
        }),
    );
    const failing = queue.run(() => {
      events.push('second');
      return Promise.reject(new Error('bad pdf'));
    });
    const third = queue.run(() => {
      events.push('third');
      return Promise.resolve('c');
    });
    await Promise.resolve();
    expect(events).toEqual(['first:start']);
    release();
    await expect(first).resolves.toBe('a');
    await expect(failing).rejects.toThrow('bad pdf');
    await expect(third).resolves.toBe('c');
    expect(events).toEqual(['first:start', 'first:end', 'second', 'third']);
  });
});
