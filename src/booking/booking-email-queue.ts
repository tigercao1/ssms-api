import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

export interface BookingEmailPacing {
  intervalMs: number;
  concurrency: number;
}

export const BOOKING_EMAIL_PACING = Symbol('BOOKING_EMAIL_PACING');

export const DEFAULT_BOOKING_EMAIL_PACING: BookingEmailPacing = {
  intervalMs: 250,
  concurrency: 2,
};

type Job = () => Promise<unknown>;

interface Entry<T> {
  job: Job;
  payload?: T;
}

export interface UnsentJob<T> {
  payload: T;
  started: boolean;
}

@Injectable()
export class BookingEmailQueue<T = unknown> {
  private readonly logger = new Logger(BookingEmailQueue.name);
  private readonly pacing: BookingEmailPacing;
  private readonly waiting: Entry<T>[] = [];
  private readonly running = new Set<Entry<T>>();
  private readonly idleWaiters: (() => void)[] = [];
  private nextStartAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(
    @Optional()
    @Inject(BOOKING_EMAIL_PACING)
    pacing?: BookingEmailPacing,
  ) {
    this.pacing = pacing ?? DEFAULT_BOOKING_EMAIL_PACING;
  }

  enqueue(job: Job, payload?: T): boolean {
    if (this.closed) {
      return false;
    }
    this.waiting.push({ job, payload });
    this.pump();
    return true;
  }

  idle(): Promise<void> {
    if (this.isIdle()) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  async close(timeoutMs: number): Promise<UnsentJob<T>[]> {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.idle(),
      new Promise<void>((resolve) => {
        deadline = setTimeout(resolve, timeoutMs);
      }),
    ]);
    clearTimeout(deadline);
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const unsent = [
      ...[...this.running].map((entry) => ({ entry, started: true })),
      ...this.waiting.splice(0).map((entry) => ({ entry, started: false })),
    ];
    return unsent.flatMap(({ entry, started }) =>
      entry.payload === undefined ? [] : [{ payload: entry.payload, started }],
    );
  }

  private pump(): void {
    if (this.timer) {
      return;
    }
    while (
      !this.closed &&
      this.waiting.length > 0 &&
      this.running.size < this.pacing.concurrency
    ) {
      const wait = this.nextStartAt - Date.now();
      if (wait > 0) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.pump();
        }, wait);
        return;
      }
      this.start(this.waiting.shift()!);
    }
    if (this.isIdle()) {
      this.idleWaiters.splice(0).forEach((resolve) => resolve());
    }
  }

  private start(entry: Entry<T>): void {
    this.running.add(entry);
    this.nextStartAt = Date.now() + this.pacing.intervalMs;
    void this.run(entry.job).finally(() => {
      this.running.delete(entry);
      this.pump();
    });
  }

  private async run(job: Job): Promise<void> {
    try {
      await job();
    } catch (err) {
      this.logger.error(
        `Booking email failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private isIdle(): boolean {
    return this.running.size === 0 && this.waiting.length === 0;
  }
}
