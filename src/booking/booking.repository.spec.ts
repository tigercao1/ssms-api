import { bookingSupabase } from '../../test/helpers/booking-fakes';
import { CLASS_COLUMNS } from '../lessons/classes.repository';
import { SupabaseBookingRepository } from './booking.repository';

const ID = '3f1c2b7a-9d4e-4c1a-8b2f-6a7e5d4c3b2a';
const SETTINGS = {
  day_start_time: '08:00:00',
  day_end_time: '18:00:00',
  slot_minutes: 30,
  weekday_overrides: {},
  updated_at: '2026-10-01T00:00:00Z',
};

describe('SupabaseBookingRepository', () => {
  it('reads and writes the single settings row', async () => {
    const { client, queries } = bookingSupabase({
      booking_settings: { data: SETTINGS, error: null },
    });
    const repo = new SupabaseBookingRepository(client);
    await expect(repo.getSettings()).resolves.toEqual(SETTINGS);
    await repo.saveSettings(
      {
        day_start_time: '09:00',
        day_end_time: '17:00',
        slot_minutes: 60,
        weekday_overrides: { sun: { closed: true } },
      },
      ID,
    );
    expect(queries[0].ops).toContainEqual(['eq', 'id', true]);
    expect(queries[1].ops).toContainEqual([
      'update',
      {
        day_start_time: '09:00',
        day_end_time: '17:00',
        slot_minutes: 60,
        weekday_overrides: { sun: { closed: true } },
        updated_by: ID,
      },
    ]);
  });

  it('fails loudly when the settings row is missing', async () => {
    const repo = new SupabaseBookingRepository(bookingSupabase().client);
    await expect(repo.getSettings()).rejects.toThrow('missing');
    await expect(
      repo.saveSettings(
        {
          day_start_time: '09:00',
          day_end_time: '17:00',
          slot_minutes: 60,
          weekday_overrides: {},
        },
        null,
      ),
    ).rejects.toThrow('missing');
  });

  it('lists active approved instructors by default, or the requested ones', async () => {
    const { client, queries } = bookingSupabase();
    const repo = new SupabaseBookingRepository(client);
    await repo.listInstructors();
    await repo.listInstructors([ID]);
    expect(queries[0].ops).toEqual(
      expect.arrayContaining([
        ['eq', 'is_active', true],
        ['eq', 'approval_status', 'approved'],
      ]),
    );
    expect(queries[1].ops).toContainEqual(['in', 'id', [ID]]);
    expect(queries[1].ops).not.toContainEqual(['eq', 'is_active', true]);
  });

  it('skips the database for empty id lists', async () => {
    const { client, queries } = bookingSupabase();
    const repo = new SupabaseBookingRepository(client);
    await expect(repo.listCalendarLinks([])).resolves.toEqual([]);
    await expect(repo.findCustomers([])).resolves.toEqual([]);
    await expect(repo.findClasses([])).resolves.toEqual([]);
    await expect(repo.busyClasses([], 'a', 'b')).resolves.toEqual([]);
    expect(queries).toEqual([]);
  });

  it('looks up references by id', async () => {
    const { client, queries } = bookingSupabase();
    const repo = new SupabaseBookingRepository(client);
    await expect(repo.findLessonType(ID)).resolves.toBeNull();
    await expect(repo.findLocation(ID)).resolves.toBeNull();
    await repo.findCustomers([ID]);
    await repo.listCalendarLinks([ID]);
    await repo.findClasses([ID]);
    expect(queries.map((q) => q.table)).toEqual([
      'lesson_types',
      'teaching_locations',
      'customers',
      'instructor_calendars',
      'classes',
    ]);
    expect(queries[4].ops).toContainEqual(['select', CLASS_COLUMNS]);
  });

  it('finds non-cancelled classes overlapping a range', async () => {
    const { client, queries } = bookingSupabase();
    await new SupabaseBookingRepository(client).busyClasses(
      [ID],
      '2026-12-12T13:00:00Z',
      '2026-12-12T23:00:00Z',
    );
    expect(queries[0].ops).toEqual(
      expect.arrayContaining([
        ['in', 'instructor_id', [ID]],
        ['neq', 'status', 'cancelled'],
        ['lt', 'starts_at', '2026-12-12T23:00:00Z'],
        ['gt', 'ends_at', '2026-12-12T13:00:00Z'],
      ]),
    );
  });

  it("finds a customer's latest class through an inner join", async () => {
    const { client, queries } = bookingSupabase({
      classes: { data: [{ id: ID }], error: null },
    });
    await expect(
      new SupabaseBookingRepository(client).lastClassForCustomer(ID),
    ).resolves.toEqual({ id: ID });
    expect(queries[0].ops).toEqual(
      expect.arrayContaining([
        ['select', expect.stringContaining('class_participants!inner')],
        ['eq', 'matched.customer_id', ID],
        ['neq', 'status', 'cancelled'],
        ['order', 'starts_at', { ascending: false }],
        ['limit', 1],
      ]),
    );
  });

  it('calls the transactional booking functions', async () => {
    const { client, rpcs } = bookingSupabase();
    const repo = new SupabaseBookingRepository(client);
    await repo.bookClasses(null, []);
    await repo.rebookClass(
      ID,
      {
        instructor_id: ID,
        lesson_type_id: null,
        starts_at: 'a',
        ends_at: 'b',
        google_calendar_id: null,
        google_event_id: null,
        notes: null,
      },
      null,
    );
    await repo.setClassStatus(ID, 'completed');
    expect(rpcs.map((r) => r.name)).toEqual([
      'book_classes',
      'rebook_class',
      'set_class_status',
    ]);
    expect(rpcs[2].args).toEqual({ p_class_id: ID, p_status: 'completed' });
  });

  it('keeps the database error code for the service to map', async () => {
    const { client } = bookingSupabase({
      'rpc:book_classes': {
        data: null,
        error: { message: 'overlaps', code: 'SB409' },
      },
    });
    await expect(
      new SupabaseBookingRepository(client).bookClasses(null, []),
    ).rejects.toMatchObject({ code: 'SB409' });
  });
});
