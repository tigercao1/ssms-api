import { Logger } from '@nestjs/common';
import {
  InMemoryBookingRepository,
  LEO_ID,
  MEI_ID,
} from '../../test/helpers/booking-fakes';
import { FAKE_SENDER_ADDRESS } from '../../test/helpers/mailer-fakes';
import type { MailerService } from '../mailer/mailer.service';
import type { SendEmailRequest } from '../mailer/mailer.types';
import { BookingEmailQueue } from './booking-email-queue';
import {
  BOOKING_EMAIL_DRAIN_MS,
  BOOKING_EMAIL_UNSENT_LOG_MS,
  BookingEmailsService,
} from './booking-emails.service';

const NOW = Date.parse('2026-12-10T17:00:00.000Z');
const CLASS_A = 'c0000000-0000-4000-8000-000000000001';

function build(sendMs: number) {
  const repo = new InMemoryBookingRepository();
  repo.customers.find((c) => c.id === LEO_ID)!.email = 'leo@example.com';
  repo.add({
    id: CLASS_A,
    starts_at: '2026-12-12T15:00:00.000Z',
    ends_at: '2026-12-12T16:00:00.000Z',
    customer_ids: [MEI_ID, LEO_ID],
  });
  const sent: string[] = [];
  const unsent: { requests: SendEmailRequest[]; reason: string }[] = [];
  const mailer = {
    senderAddress: () => FAKE_SENDER_ADDRESS,
    send: (request: SendEmailRequest) =>
      new Promise((resolve) =>
        setTimeout(() => {
          sent.push(request.to);
          resolve('sent');
        }, sendMs),
      ),
    recordUnsent: jest.fn((requests: SendEmailRequest[], reason: string) => {
      unsent.push({ requests, reason });
      return Promise.resolve();
    }),
  };
  const queue = new BookingEmailQueue<never>({ intervalMs: 0, concurrency: 1 });
  const service = new BookingEmailsService(
    repo,
    mailer as unknown as MailerService,
    queue,
    { now: () => NOW },
  );
  return { service, mailer, sent, unsent };
}

describe('BookingEmailsService shutdown', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('drains the queue before shutting down and logs nothing when all are sent', async () => {
    const { service, mailer, sent } = build(500);
    await service.booked([CLASS_A]);

    const shutdown = service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(1_500);
    await shutdown;

    expect(sent).toEqual([
      'mei@example.com',
      'leo@example.com',
      'amy@example.com',
    ]);
    expect(mailer.recordUnsent).not.toHaveBeenCalled();
  });

  it('stops after the drain window and logs every unsent email as failed with reason shutdown', async () => {
    const { service, sent, unsent } = build(2_000);
    await service.booked([CLASS_A]);

    let done = false;
    const shutdown = service.onModuleDestroy().then(() => (done = true));
    await jest.advanceTimersByTimeAsync(BOOKING_EMAIL_DRAIN_MS - 1);
    expect(done).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await shutdown;

    expect(sent).toEqual(['mei@example.com']);
    expect(unsent).toHaveLength(1);
    expect(unsent[0].reason).toBe('shutdown');
    expect(
      unsent[0].requests.map((r) => [r.template, r.to, r.metadata?.started]),
    ).toEqual([
      ['booking.confirmed.customer', 'leo@example.com', true],
      ['booking.confirmed.instructor', 'amy@example.com', false],
    ]);
    expect(unsent[0].requests[0].metadata).toMatchObject({
      booking: 'confirmed',
      classIds: [CLASS_A],
      customerId: LEO_ID,
    });
  });

  it('logs an email booked after the queue closed instead of dropping it', async () => {
    const { service, unsent } = build(10);
    const shutdown = service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(0);
    await shutdown;

    await service.booked([CLASS_A]);
    await jest.advanceTimersByTimeAsync(0);

    expect(unsent.flatMap((u) => u.requests.map((r) => r.to))).toEqual([
      'mei@example.com',
      'leo@example.com',
      'amy@example.com',
    ]);
    expect(unsent.every((u) => u.reason === 'shutdown')).toBe(true);
  });

  it('waits for the email_log write and warns per email booked after the queue closed', async () => {
    const { service, mailer, unsent } = build(10);
    await service.onModuleDestroy();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    let written!: () => void;
    mailer.recordUnsent.mockImplementationOnce(
      (requests: SendEmailRequest[], reason: string) =>
        new Promise<void>((resolve) => {
          written = () => {
            unsent.push({ requests, reason });
            resolve();
          };
        }),
    );

    let done = false;
    const booking = service.booked([CLASS_A]).then(() => (done = true));
    await jest.advanceTimersByTimeAsync(0);
    expect(mailer.recordUnsent).toHaveBeenCalledTimes(1);
    expect(done).toBe(false);

    written();
    await booking;

    expect(unsent.flatMap((u) => u.requests.map((r) => r.to))).toHaveLength(3);
    expect(warn).toHaveBeenCalledTimes(3);
    const lines = warn.mock.calls.map(([line]) => String(line));
    expect(lines).toEqual([
      expect.stringContaining('booking.confirmed.customer'),
      expect.stringContaining('booking.confirmed.customer'),
      expect.stringContaining('booking.confirmed.instructor'),
    ]);
    expect(lines.every((l) => l.includes(CLASS_A))).toBe(true);
    expect(lines.some((l) => l.includes('@'))).toBe(false);
  });

  it('gives up waiting on the email_log write after its time budget', async () => {
    const { service, mailer } = build(60_000);
    mailer.recordUnsent.mockReturnValue(new Promise(() => undefined));
    await service.booked([CLASS_A]);

    let done = false;
    void service.onModuleDestroy().then(() => (done = true));
    await jest.advanceTimersByTimeAsync(BOOKING_EMAIL_DRAIN_MS);
    expect(mailer.recordUnsent).toHaveBeenCalledTimes(1);
    expect(done).toBe(false);
    await jest.advanceTimersByTimeAsync(BOOKING_EMAIL_UNSENT_LOG_MS);

    expect(done).toBe(true);
    expect(BOOKING_EMAIL_DRAIN_MS + BOOKING_EMAIL_UNSENT_LOG_MS).toBeLessThan(
      5_000,
    );
  });
});
