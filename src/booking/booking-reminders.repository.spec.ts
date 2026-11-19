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

  it('pages through scheduled lessons booked in SSMS with emails on', async () => {
    const { client, queries } = bookingSupabase();
    const repo = new SupabaseBookingRemindersRepository(client);
    await expect(
      repo.remindableClassesStartingBetween('a', 'b'),
    ).resolves.toEqual([]);
    expect(queries[0].table).toBe('classes');
    const select = queries[0].ops.find((op) => op[0] === 'select')?.[1];
    expect(select).toContain('starts_at_set_at');
    expect(select).toContain('customers(first_name, last_name, email)');
    expect(queries[0].ops).toEqual(
      expect.arrayContaining([
        ['eq', 'status', 'scheduled'],
        ['eq', 'source', 'ssms'],
        ['eq', 'send_emails', true],
        ['gt', 'starts_at', 'a'],
        ['lte', 'starts_at', 'b'],
        ['range', 0, DB_PAGE_SIZE - 1],
      ]),
    );
  });

  it('lists existing claims for an offset in chunks of class ids', async () => {
    const { client, queries } = bookingSupabase({
      booking_reminder_sends: { data: [CLAIM], error: null },
    });
    const repo = new SupabaseBookingRemindersRepository(client);
    const ids = Array.from({ length: 150 }, (_, i) => `class-${i}`);
    await expect(repo.claimed(ids, 60)).resolves.toEqual([CLAIM, CLAIM]);
    expect(queries).toHaveLength(2);
    expect(queries[0].ops).toEqual(
      expect.arrayContaining([
        ['in', 'class_id', ids.slice(0, 100)],
        ['eq', 'offset_minutes', 60],
      ]),
    );
    expect(queries[1].ops).toContainEqual(['in', 'class_id', ids.slice(100)]);
    await expect(repo.claimed([], 60)).resolves.toEqual([]);
    expect(queries).toHaveLength(2);
  });

  it('marks claims older than the cutoff failed as stale', async () => {
    const stale = {
      id: 'r1',
      class_id: CLAIM.class_id,
      offset_minutes: 60,
      audience: 'customer',
    };
    const { client, queries } = bookingSupabase({
      booking_reminder_sends: { data: [stale], error: null },
    });
    await expect(
      new SupabaseBookingRemindersRepository(client).failStaleClaims('cutoff'),
    ).resolves.toEqual([stale]);
    expect(queries[0].ops).toEqual(
      expect.arrayContaining([
        [
          'update',
          expect.objectContaining({ status: 'failed', reason: 'stale_claim' }),
        ],
        ['eq', 'status', 'claimed'],
        ['lt', 'claimed_at', 'cutoff'],
        ['select', 'id, class_id, offset_minutes, audience'],
      ]),
    );
    const none = bookingSupabase();
    await expect(
      new SupabaseBookingRemindersRepository(none.client).failStaleClaims('x'),
    ).resolves.toEqual([]);
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
