import { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  type MultipartTarget,
  type UploadedPart,
  uploadInParts,
} from './multipart-upload';

function recordingTarget(overrides: Partial<MultipartTarget> = {}) {
  const parts: { partNumber: number; body: Buffer }[] = [];
  const calls: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let completed: UploadedPart[] | null = null;
  const target: MultipartTarget = {
    start: () => {
      calls.push('start');
      return Promise.resolve('u1');
    },
    uploadPart: async (_id, partNumber, body) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(partNumber % 2 === 0 ? 1 : 5);
      parts.push({ partNumber, body: Buffer.from(body) });
      inFlight -= 1;
      return `e${partNumber}`;
    },
    complete: (_id, list) => {
      calls.push('complete');
      completed = list;
      return Promise.resolve();
    },
    abort: () => {
      calls.push('abort');
      return Promise.resolve();
    },
    ...overrides,
  };
  return {
    target,
    parts,
    calls,
    maxInFlight: () => maxInFlight,
    completed: () => completed,
  };
}

const chunks = (sizes: number[]) =>
  Readable.from(sizes.map((n, i) => Buffer.alloc(n, 65 + i)));

describe('uploadInParts', () => {
  it('splits the body into fixed-size parts with at most two in flight, completing in part order', async () => {
    const t = recordingTarget();
    const total = await uploadInParts(chunks([7, 3, 12, 1, 4]), t.target, {
      partSize: 5,
    });
    expect(total).toBe(27);
    expect(t.maxInFlight()).toBe(2);
    const sorted = [...t.parts].sort((a, b) => a.partNumber - b.partNumber);
    expect(sorted.map((p) => p.body.length)).toEqual([5, 5, 5, 5, 5, 2]);
    expect(Buffer.concat(sorted.map((p) => p.body)).toString()).toBe(
      'AAAAAAABBBCCCCCCCCCCCCDEEEE',
    );
    expect(t.completed()).toEqual(
      [1, 2, 3, 4, 5, 6].map((n) => ({ partNumber: n, etag: `e${n}` })),
    );
    expect(t.calls).toEqual(['start', 'complete']);
  });

  it('uploads one empty part for an empty body and exact multiples without a trailing part', async () => {
    const empty = recordingTarget();
    await expect(
      uploadInParts(Readable.from([]), empty.target, { partSize: 4 }),
    ).resolves.toBe(0);
    expect(empty.parts.map((p) => p.body.length)).toEqual([0]);

    const exact = recordingTarget();
    await uploadInParts(chunks([4, 4]), exact.target, { partSize: 4 });
    expect(exact.parts.map((p) => p.body.length)).toEqual([4, 4]);
  });

  it('aborts and rethrows when a part fails', async () => {
    const t = recordingTarget({
      uploadPart: (_id, n) =>
        n === 2
          ? Promise.reject(new Error('part 2 failed'))
          : Promise.resolve('e'),
    });
    await expect(
      uploadInParts(chunks([20]), t.target, { partSize: 4, maxInFlight: 1 }),
    ).rejects.toThrow('part 2 failed');
    expect(t.calls).toEqual(['start', 'abort']);
  });

  it('aborts when the last part fails, wrapping non-errors', async () => {
    const t = recordingTarget({
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      uploadPart: () => Promise.reject('nope'),
    });
    await expect(
      uploadInParts(chunks([3]), t.target, { partSize: 4 }),
    ).rejects.toThrow('nope');
    expect(t.calls).toEqual(['start', 'abort']);
  });

  it('aborts when the body errors, even if abort itself fails', async () => {
    const t = recordingTarget({
      abort: () => Promise.reject(new Error('abort failed')),
    });
    const body = new Readable({
      read() {
        this.destroy(new Error('body broke'));
      },
    });
    await expect(uploadInParts(body, t.target)).rejects.toThrow('body broke');
  });
});
