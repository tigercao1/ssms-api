import { bookingSupabase } from '../../test/helpers/booking-fakes';
import { DB_PAGE_SIZE } from '../database/pagination';
import { SupabaseBookingRemindersRepository } from './booking-reminders.repository';

const ID = '3f1c2b7a-9d4e-4c1a-8b2f-6a7e5d4c3b2a';
const SETTINGS = {
  enabled: true,
  offsets_minutes: [1440, 60],
  updated_at: '2026-10-01T00:00:00Z',
};
const CLAIM = {
  class_id: ID,
  starts_at: '2026-12-12T15:00:00.000Z',
  offset_minutes: 60,
  audience: 'customer' as const,
  recipient_id: ID,
};

describe('SupabaseBookingRemindersRepository', () => {
  it('reads and writes the single reminder settings row', async () => {
    const { client, queries } = bookingSupabase({
      booking_reminder_settings: { data: SETTINGS, error: null },
    });
    const repo = new SupabaseBookingRemindersRepository(client);
    await expect(repo.getSettings()).resolves.toEqual(SETTINGS);
    await repo.saveSettings({ enabled: false, offsets_minutes: [180] }, ID);
    expect(queries[0].ops).toContainEqual(['eq', 'id', true]);
    expect(queries[1].ops).toContainEqual([
      'update',
      { enabled: false, offsets_minutes: [180], updated_by: ID },
    ]);
  });

  it('fails loudly when the reminder settings row is missing', async () => {
    const repo = new SupabaseBookingRemindersRepository(
      bookingSupabase().client,
    );
    await expect(repo.getSettings()).rejects.toThrow('missing');
    await expect(
      repo.saveSettings({ enabled: true, offsets_minutes: [60] }, null),
    ).rejects.toThrow('missing');
  });

  it('pages through classes starting in a window with status and sendEmails', async () => {
    const { client, queries } = bookingSupabase();
    const repo = new SupabaseBookingRemindersRepository(client);
    await expect(repo.classesStartingBetween('a', 'b')).resolves.toEqual([]);
    expect(queries[0].table).toBe('classes');
    const select = queries[0].ops.find((op) => op[0] === 'select')?.[1];
    expect(select).toContain('status, send_emails');
    expect(select).toContain('customers(first_name, last_name, email)');
    expect(queries[0].ops).toEqual(
      expect.arrayContaining([
        ['gt', 'starts_at', 'a'],
        ['lte', 'starts_at', 'b'],
        ['range', 0, DB_PAGE_SIZE - 1],
      ]),
    );
  });

  it('claims a reminder once, ignoring an existing claim', async () => {
    const fresh = bookingSupabase({
      booking_reminder_sends: { data: [{ id: 'r1' }], error: null },
    });
    await expect(
      new SupabaseBookingRemindersRepository(fresh.client).claim(CLAIM),
    ).resolves.toBe('r1');
    expect(fresh.queries[0].ops).toContainEqual([
      'upsert',
      CLAIM,
      {
        onConflict: 'class_id,starts_at,offset_minutes,audience,recipient_id',
        ignoreDuplicates: true,
      },
    ]);
    const taken = bookingSupabase({
      booking_reminder_sends: { data: [], error: null },
    });
    await expect(
      new SupabaseBookingRemindersRepository(taken.client).claim(CLAIM),
    ).resolves.toBeNull();
  });

  it('finishes or releases only a claimed reminder', async () => {
    const { client, queries } = bookingSupabase();
    const repo = new SupabaseBookingRemindersRepository(client);
    await repo.finish('r1', 'sent');
    await repo.release('r2');
    expect(queries[0].ops).toEqual(
      expect.arrayContaining([
        ['update', expect.objectContaining({ status: 'sent' })],
        ['eq', 'id', 'r1'],
        ['eq', 'status', 'claimed'],
      ]),
    );
    expect(queries[1].ops).toEqual(
      expect.arrayContaining([
        ['delete'],
        ['eq', 'id', 'r2'],
        ['eq', 'status', 'claimed'],
      ]),
    );
  });

  it('surfaces database errors', async () => {
    const { client } = bookingSupabase({
      booking_reminder_sends: { data: null, error: { message: 'boom' } },
    });
    await expect(
      new SupabaseBookingRemindersRepository(client).claim(CLAIM),
    ).rejects.toThrow('boom');
  });
});
