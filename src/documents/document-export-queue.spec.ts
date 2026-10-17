import { Logger } from '@nestjs/common';
import { DocumentExportQueue } from './document-export-queue';

describe('DocumentExportQueue', () => {
  afterEach(() => jest.restoreAllMocks());

  it('runs jobs one at a time in order and keeps going after a failure', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const queue = new DocumentExportQueue();
    const events: string[] = [];
    let running = 0;
    const job =
      (name: string, fail = false) =>
      async () => {
        running += 1;
        expect(running).toBe(1);
        events.push(`start ${name}`);
        await new Promise((r) => setTimeout(r, 2));
        events.push(`end ${name}`);
        running -= 1;
        if (fail) {
          throw new Error(`${name} broke`);
        }
      };

    queue.enqueue(job('a', true));
    queue.enqueue(job('b'));
    queue.enqueue(() => Promise.reject(new Error('plain')));
    expect(queue.size).toBe(3);
    await queue.idle();

    expect(events).toEqual(['start a', 'end a', 'start b', 'end b']);
    expect(queue.size).toBe(0);
    expect(error).toHaveBeenCalledWith('Export job failed: a broke');
    expect(error).toHaveBeenCalledWith('Export job failed: plain');
  });
});
