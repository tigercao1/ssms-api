import { Logger } from '@nestjs/common';
import {
  BookingEmailQueue,
  DEFAULT_BOOKING_EMAIL_PACING,
} from './booking-email-queue';

const RESEND_REQUESTS_PER_SECOND = 10;

describe('BookingEmailQueue', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: Date.parse('2026-12-10T17:00:00.000Z') });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const job = (starts: number[], durationMs: number) => () => {
    starts.push(Date.now());
    return new Promise<void>((resolve) => setTimeout(resolve, durationMs));
  };

  it('spaces starts by the interval and keeps a batch under 10 sends a second', async () => {
    const queue = new BookingEmailQueue();
    const starts: number[] = [];
    for (let i = 0; i < 30; i++) {
      queue.enqueue(job(starts, 10));
    }
    expect(starts).toHaveLength(1);

    await jest.advanceTimersByTimeAsync(10_000);
    await queue.idle();

    expect(starts).toHaveLength(30);
    const gaps = starts.slice(1).map((at, i) => at - starts[i]);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(
      DEFAULT_BOOKING_EMAIL_PACING.intervalMs,
    );
    for (const at of starts) {
      const inWindow = starts.filter((t) => t >= at && t < at + 1_000);
      expect(inWindow.length).toBeLessThan(RESEND_REQUESTS_PER_SECOND);
    }
  });

  it('runs at most `concurrency` sends at once', async () => {
    const queue = new BookingEmailQueue({ intervalMs: 0, concurrency: 2 });
    let running = 0;
    let peak = 0;
    for (let i = 0; i < 6; i++) {
      queue.enqueue(async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        running--;
      });
    }

    await jest.advanceTimersByTimeAsync(5_000);
    await queue.idle();

    expect(peak).toBe(2);
    expect(running).toBe(0);
  });

  it('keeps going after a send throws or rejects', async () => {
    const queue = new BookingEmailQueue({ intervalMs: 100, concurrency: 1 });
    const done: string[] = [];
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    queue.enqueue(() => {
      throw new Error('boom');
    });
    queue.enqueue(() => Promise.reject(new Error('down')));
    queue.enqueue(() => {
      done.push('third');
      return Promise.resolve();
    });

    await jest.advanceTimersByTimeAsync(1_000);
    await queue.idle();

    expect(done).toEqual(['third']);
    expect(error.mock.calls.map(([line]) => String(line))).toEqual([
      'Booking email failed: boom',
      'Booking email failed: down',
    ]);
    error.mockRestore();
  });
});
