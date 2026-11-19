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

@Injectable()
export class BookingEmailQueue {
  private readonly logger = new Logger(BookingEmailQueue.name);
  private readonly pacing: BookingEmailPacing;
  private readonly waiting: Job[] = [];
  private readonly idleWaiters: (() => void)[] = [];
  private active = 0;
  private nextStartAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    @Optional()
    @Inject(BOOKING_EMAIL_PACING)
    pacing?: BookingEmailPacing,
  ) {
    this.pacing = pacing ?? DEFAULT_BOOKING_EMAIL_PACING;
  }

  enqueue(job: Job): void {
    this.waiting.push(job);
    this.pump();
  }

  idle(): Promise<void> {
    if (this.isIdle()) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private pump(): void {
    if (this.timer) {
      return;
    }
    while (this.waiting.length > 0 && this.active < this.pacing.concurrency) {
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

  private start(job: Job): void {
    this.active++;
    this.nextStartAt = Date.now() + this.pacing.intervalMs;
    void this.run(job).finally(() => {
      this.active--;
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
    return this.active === 0 && this.waiting.length === 0;
  }
}
