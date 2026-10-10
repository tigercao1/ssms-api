import { KeyedLock } from './keyed-lock';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('KeyedLock', () => {
  it('runs tasks for one key one at a time, in order', async () => {
    const lock = new KeyedLock();
    const first = deferred<string>();
    const started: string[] = [];
    const a = lock.run('k', () => {
      started.push('a');
      return first.promise;
    });
    const b = lock.run('k', () => {
      started.push('b');
      return Promise.resolve('b');
    });
    await flush();
    expect(started).toEqual(['a']);
    first.resolve('a');
    await expect(a).resolves.toBe('a');
    await expect(b).resolves.toBe('b');
    expect(started).toEqual(['a', 'b']);
    expect(lock.size).toBe(0);
  });

  it('runs tasks for different keys concurrently', async () => {
    const lock = new KeyedLock();
    const held = deferred<void>();
    const a = lock.run('a', () => held.promise);
    await expect(lock.run('b', () => Promise.resolve(2))).resolves.toBe(2);
    expect(lock.size).toBe(1);
    held.resolve();
    await a;
    expect(lock.size).toBe(0);
  });

  it('releases the key when a task throws', async () => {
    const lock = new KeyedLock();
    const failing = deferred<void>();
    const a = lock.run('k', () => failing.promise);
    const b = lock.run('k', () => Promise.resolve('after'));
    failing.reject(new Error('boom'));
    await expect(a).rejects.toThrow('boom');
    await expect(b).resolves.toBe('after');
    expect(lock.size).toBe(0);
    await expect(
      lock.run('k', () => Promise.reject(new Error('again'))),
    ).rejects.toThrow('again');
    expect(lock.size).toBe(0);
  });
});
