import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  ADMIN_AUTH as admin,
  ADMIN_ID,
  INSTRUCTOR_AUTH,
  startAdminApp,
} from '../../test/helpers/admin-http';
import {
  InMemoryBookingRemindersRepository,
  InMemoryBookingRepository,
} from '../../test/helpers/booking-fakes';
import { recordingAudit } from '../../test/helpers/public-pages-fakes';
import { AuditService } from '../audit/audit.service';
import {
  BookingReminderSettingsService,
  REMINDER_OFFSET_RANGE,
  REMINDER_OFFSETS_DUPLICATE,
  REMINDER_OFFSETS_REQUIRED,
  REMINDER_OFFSETS_TOO_MANY,
} from './booking-reminder-settings.service';
import { BookingRemindersController } from './booking-reminders.controller';
import { BookingRemindersRepository } from './booking-reminders.repository';

const ROUTE = '/admin/booking/reminder-settings';

async function build() {
  const repo = new InMemoryBookingRemindersRepository(
    new InMemoryBookingRepository(),
  );
  const audit = recordingAudit();
  const app = await startAdminApp(
    Test.createTestingModule({
      controllers: [BookingRemindersController],
      providers: [
        BookingReminderSettingsService,
        { provide: BookingRemindersRepository, useValue: repo },
        { provide: AuditService, useValue: audit },
      ],
    }),
  );
  return { app, repo, audit };
}

describe('booking reminder settings HTTP', () => {
  let ctx: Awaited<ReturnType<typeof build>>;
  const http = () => request(ctx.app.getHttpServer());
  const put = (body: unknown) =>
    http()
      .put(ROUTE)
      .set('Authorization', admin)
      .send(body as object);

  beforeEach(async () => {
    ctx = await build();
  });

  afterEach(async () => {
    await ctx.app.close();
  });

  it.each([
    ['GET', () => http().get(ROUTE)],
    ['PUT', () => http().put(ROUTE).send({})],
  ])('%s requires an admin', async (_name, send) => {
    await send().expect(401);
    await send().set('Authorization', INSTRUCTOR_AUTH).expect(403);
  });

  it('returns a day and an hour before by default', async () => {
    const res = await http().get(ROUTE).set('Authorization', admin).expect(200);
    expect(res.body).toEqual({
      enabled: true,
      offsetsMinutes: [1440, 60],
      updatedAt: '2026-10-01T00:00:00.000Z',
    });
  });

  it('saves new reminder times longest first and audits the change', async () => {
    const res = await put({
      enabled: true,
      offsetsMinutes: [180, 2880, 15, 20160],
    }).expect(200);
    expect(res.body).toMatchObject({
      enabled: true,
      offsetsMinutes: [20160, 2880, 180, 15],
    });
    expect(ctx.repo.settings.offsets_minutes).toEqual([20160, 2880, 180, 15]);
    expect(ctx.repo.savedBy).toEqual([ADMIN_ID]);
    expect(ctx.audit.entries).toHaveLength(1);
    expect(ctx.audit.entries[0]).toMatchObject({
      action: 'booking.reminder_settings_update',
      targetType: 'booking_reminder_settings',
      actor: { userId: ADMIN_ID, role: 'admin' },
      metadata: {
        from: { enabled: true, offsetsMinutes: [1440, 60] },
        to: { enabled: true, offsetsMinutes: [20160, 2880, 180, 15] },
      },
    });
  });

  it.each([[[1440, 60]], [[]]])(
    'turns reminders off, keeping %j',
    async (offsetsMinutes) => {
      const res = await put({ enabled: false, offsetsMinutes }).expect(200);
      expect(res.body).toMatchObject({ enabled: false, offsetsMinutes });
    },
  );

  it('needs at least one reminder time while reminders are on', async () => {
    const res = await put({ enabled: true, offsetsMinutes: [] }).expect(400);
    expect((res.body as { message: string }).message).toBe(
      REMINDER_OFFSETS_REQUIRED,
    );
    expect(ctx.audit.entries).toEqual([]);
  });

  it.each([
    [
      { enabled: true, offsetsMinutes: [60, 120, 180, 240, 300, 360] },
      REMINDER_OFFSETS_TOO_MANY,
    ],
    [{ enabled: true, offsetsMinutes: [60, 60] }, REMINDER_OFFSETS_DUPLICATE],
    [{ enabled: true, offsetsMinutes: [14] }, REMINDER_OFFSET_RANGE],
    [{ enabled: true, offsetsMinutes: [20161] }, REMINDER_OFFSET_RANGE],
    [{ enabled: true, offsetsMinutes: [90.5] }, REMINDER_OFFSET_RANGE],
    [{ enabled: true, offsetsMinutes: ['60'] }, REMINDER_OFFSET_RANGE],
  ])('rejects %j', async (body, message) => {
    const res = await put(body).expect(400);
    expect((res.body as { message: string[] }).message).toContain(message);
    expect(ctx.repo.savedBy).toEqual([]);
  });

  it.each([
    {},
    { enabled: true },
    { offsetsMinutes: [60] },
    { enabled: 'yes', offsetsMinutes: [60] },
    { enabled: true, offsetsMinutes: 60 },
    { enabled: true, offsetsMinutes: [60], extra: 1 },
  ])('rejects malformed settings %j', async (body) => {
    await put(body).expect(400);
    expect(ctx.repo.savedBy).toEqual([]);
  });
});
