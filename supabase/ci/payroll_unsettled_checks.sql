\set ON_ERROR_STOP on
begin;

insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111192', 'ci-unsettled-ada@example.com'),
  ('11111111-1111-4111-8111-111111111193', 'ci-unsettled-bo@example.com'),
  ('11111111-1111-4111-8111-111111111194', 'ci-unsettled-cy@example.com');
insert into instructors (id, auth_user_id, email, display_name_en) values
  ('22222222-2222-4222-8222-222222222292', '11111111-1111-4111-8111-111111111192', 'ci-unsettled-ada@example.com', 'CI Ada'),
  ('22222222-2222-4222-8222-222222222293', '11111111-1111-4111-8111-111111111193', 'ci-unsettled-bo@example.com', 'CI Bo'),
  ('22222222-2222-4222-8222-222222222294', '11111111-1111-4111-8111-111111111194', 'ci-unsettled-cy@example.com', 'CI Cy');
insert into lesson_types (id, name_en, group_size, duration_min) values
  ('44444444-4444-4444-8444-444444444492', 'Unsettled Private 90', 1, 90),
  ('44444444-4444-4444-8444-444444444493', 'Unsettled Day', 1, 360),
  ('44444444-4444-4444-8444-444444444494', 'Unsettled Unpriced', 1, 60),
  ('44444444-4444-4444-8444-444444444495', 'Unsettled USD', 1, 90),
  ('44444444-4444-4444-8444-444444444496', 'Unsettled Other', 1, 90);
insert into pay_rates (lesson_type_id, instructor_id, hourly_rate, rate_unit, effective_from, effective_to) values
  ('44444444-4444-4444-8444-444444444492', '22222222-2222-4222-8222-222222222292', 40, 'hour', '2020-01-01', '2026-01-04'),
  ('44444444-4444-4444-8444-444444444492', '22222222-2222-4222-8222-222222222292', 50, 'hour', '2026-01-05', '2026-01-05'),
  ('44444444-4444-4444-8444-444444444492', '22222222-2222-4222-8222-222222222292', 40, 'hour', '2026-01-06', null),
  ('44444444-4444-4444-8444-444444444492', '22222222-2222-4222-8222-222222222293', 80, 'hour', '2020-01-01', null),
  ('44444444-4444-4444-8444-444444444492', null, 35, 'hour', '2020-01-01', null),
  ('44444444-4444-4444-8444-444444444493', '22222222-2222-4222-8222-222222222292', 200, 'day', '2020-01-01', null),
  ('44444444-4444-4444-8444-444444444496', '22222222-2222-4222-8222-222222222292', 30, 'hour', '2020-01-01', '2025-12-31'),
  ('44444444-4444-4444-8444-444444444496', '22222222-2222-4222-8222-222222222292', 60, 'hour', '2026-01-01', null);
insert into pay_rates (lesson_type_id, instructor_id, hourly_rate, rate_unit, currency, effective_from) values
  ('44444444-4444-4444-8444-444444444495', '22222222-2222-4222-8222-222222222292', 50, 'hour', 'USD', '2020-01-01');
insert into payroll_periods (id, starts_on, ends_on) values
  ('66666666-6666-4666-8666-666666666601', '2025-12-15', '2025-12-28'),
  ('66666666-6666-4666-8666-666666666602', '2025-12-29', '2026-01-11'),
  ('66666666-6666-4666-8666-666666666603', '2026-01-12', '2026-01-25'),
  ('66666666-6666-4666-8666-666666666604', '2026-01-26', '2026-02-08');

create temp table expected (
  n          int primary key,
  label      text not null,
  instructor text not null,
  starts_at  timestamptz not null,
  status     text not null,
  unsettled  boolean not null,
  lesson     text not null default 'p90',
  minutes    int not null default 90
);

insert into expected values
  (1,  '23:30 Toronto on the last day of a finalized period',      'ada', '2026-01-11 23:30 America/Toronto', 'completed', true),
  (2,  '00:00 Toronto on the first day of an open period',         'ada', '2026-01-12 00:00 America/Toronto', 'completed', false),
  (3,  '00:00 Toronto on the first day of a finalized period',     'ada', '2025-12-15 00:00 America/Toronto', 'completed', true),
  (4,  '23:59 Toronto the day before any period',                  'ada', '2025-12-14 23:59 America/Toronto', 'completed', false),
  (5,  'cancelled, never paid',                                    'ada', '2025-12-16 10:00 America/Toronto', 'cancelled', false),
  (6,  'paid and settled',                                         'ada', '2025-12-17 10:00 America/Toronto', 'completed', false),
  (7,  'paid, then cancelled',                                     'ada', '2025-12-18 10:00 America/Toronto', 'cancelled', true),
  (8,  'paid zero with needs_rate, rate set since',                'ada', '2025-12-19 10:00 America/Toronto', 'completed', false),
  (9,  'past scheduled, never paid',                               'ada', '2025-12-20 10:00 America/Toronto', 'scheduled', true),
  (10, 'net zero through a late cancel while active',              'ada', '2025-12-21 10:00 America/Toronto', 'completed', true),
  (11, 'paid, then marked already paid on a move',                 'ada', '2025-12-22 10:00 America/Toronto', 'completed', false),
  (12, 'paid, then moved into an open period',                     'ada', '2026-01-13 10:00 America/Toronto', 'completed', false),
  (13, 'only an already-paid line',                                'ada', '2025-12-23 10:00 America/Toronto', 'completed', true),
  (14, 'top-up after a reopen settles at what was first paid',     'ada', '2025-12-24 10:00 America/Toronto', 'completed', false),
  (15, 'paid twice, still active',                                 'ada', '2025-12-25 10:00 America/Toronto', 'completed', true),
  (16, 'paid to Ada, now on Bo',                                   'bo',  '2025-12-26 10:00 America/Toronto', 'completed', true),
  (17, 'reassignment settled: Ada 0, Bo paid',                     'bo',  '2025-12-27 10:00 America/Toronto', 'completed', false),
  (18, 'reassignment settled, then back on Ada',                   'ada', '2025-12-28 10:00 America/Toronto', 'completed', true),
  (19, 'reassignment settled, then cancelled',                     'bo',  '2025-12-29 10:00 America/Toronto', 'cancelled', true),
  (20, 'reassignment settled, cancelled and reversed',             'bo',  '2025-12-30 10:00 America/Toronto', 'cancelled', false),
  (21, 'paid to Ada, moved into an open period on Bo',             'bo',  '2026-01-14 10:00 America/Toronto', 'completed', true),
  (22, 'paid to Ada, moved into an open period on Bo, cancelled',  'bo',  '2026-01-15 10:00 America/Toronto', 'cancelled', true),
  (23, 'cancelled, restored, then the first period refinalized',   'ada', '2025-12-17 11:00 America/Toronto', 'completed', true),
  (24, 'away and back, then the first period refinalized',         'ada', '2025-12-17 12:00 America/Toronto', 'completed', true),
  (25, 'paid to Ada, settled onto Bo in an open period',           'bo',  '2026-01-16 10:00 America/Toronto', 'completed', false),
  (26, 'Ada paid and reversed, moved into an open period on Bo',   'bo',  '2026-01-17 10:00 America/Toronto', 'completed', false);

insert into expected values
  (27, 'paid at a daily rate and settled',                         'ada', '2025-12-17 13:00 America/Toronto', 'completed', false, 'day', 90),
  (28, 'paid at a daily rate, then paid again',                    'ada', '2025-12-17 14:00 America/Toronto', 'completed', true,  'day', 90),
  (29, 'paid, then made longer',                                   'ada', '2025-12-17 15:00 America/Toronto', 'completed', true,  'p90', 120),
  (30, 'paid, then made shorter',                                  'ada', '2025-12-17 16:00 America/Toronto', 'completed', true,  'p90', 60),
  (31, 'paid, made longer and the extra minutes settled',          'ada', '2025-12-17 17:00 America/Toronto', 'completed', false, 'p90', 120),
  (32, 'paid, then given a daily lesson type',                     'ada', '2025-12-17 18:00 America/Toronto', 'completed', true,  'day', 360),
  (33, 'paid at a daily rate, then made shorter',                  'ada', '2025-12-17 19:00 America/Toronto', 'completed', false, 'day', 60),
  (34, 'paid at 40, a dated rate of 50 now covers the day',        'ada', '2026-01-05 10:00 America/Toronto', 'completed', false, 'p90', 90),
  (35, 'paid at the dated rate of 50',                             'ada', '2026-01-05 11:00 America/Toronto', 'completed', false, 'p90', 90),
  (36, 'paid at 40 the day after the dated rate',                  'ada', '2026-01-06 10:00 America/Toronto', 'completed', false, 'p90', 90),
  (37, 'dated rate by the Toronto day at 23:30',                   'ada', '2026-01-05 23:30 America/Toronto', 'completed', false, 'p90', 90),
  (38, 'Toronto day after the dated rate at 00:30',                'ada', '2026-01-06 00:30 America/Toronto', 'completed', false, 'p90', 90),
  (39, 'paid at the default rate, no override',                    'cy',  '2025-12-18 11:00 America/Toronto', 'completed', false, 'p90', 90),
  (40, 'paid at an older default rate, no override',              'cy',  '2025-12-18 12:00 America/Toronto', 'completed', false, 'p90', 90),
  (41, 'paid in CAD, lesson type now paid in USD',                 'ada', '2025-12-18 13:00 America/Toronto', 'completed', true, 'usd', 90),
  (42, 'CAD paid and taken back, USD paid for the new type',       'ada', '2025-12-18 14:00 America/Toronto', 'completed', false, 'usd', 90),
  (43, 'paid zero with needs_rate, still no rate',                 'ada', '2025-12-18 15:00 America/Toronto', 'completed', false, 'none', 60),
  (44, 'paid, lesson type now has no rate',                        'ada', '2025-12-18 16:00 America/Toronto', 'completed', true,  'none', 60),
  (45, 'paid, lesson type removed',                                'ada', '2025-12-18 17:00 America/Toronto', 'completed', true,  'null', 90),
  (46, 'paid, cancelled after a length change was settled',        'ada', '2025-12-18 18:00 America/Toronto', 'cancelled', true,  'p90', 120),
  (47, 'paid in USD at a daily rate, table now 40 an hour in CAD', 'ada', '2025-12-18 19:00 America/Toronto', 'completed', false, 'p90', 90),
  (48, 'paid, new type priced on the lesson date',                 'ada', '2025-12-18 20:00 America/Toronto', 'completed', true,  'other', 90),
  (49, 'new type settled at its rate on the lesson date',          'ada', '2025-12-18 21:00 America/Toronto', 'completed', false, 'other', 90),
  (50, 'new type settled, then back to the first type',            'ada', '2025-12-18 22:00 America/Toronto', 'completed', true,  'p90', 90),
  (51, 'new type settled on the lesson date at a rate since moved', 'ada', '2025-12-19 11:00 America/Toronto', 'completed', false, 'other', 90);

insert into classes (id, instructor_id, lesson_type_id, starts_at, ends_at, status)
select ('55555555-5555-4555-8555-' || lpad(n::text, 12, '0'))::uuid,
       case instructor
         when 'ada' then '22222222-2222-4222-8222-222222222292'::uuid
         when 'bo' then '22222222-2222-4222-8222-222222222293'::uuid
         else '22222222-2222-4222-8222-222222222294'::uuid
       end,
       case lesson
         when 'p90' then '44444444-4444-4444-8444-444444444492'::uuid
         when 'day' then '44444444-4444-4444-8444-444444444493'::uuid
         when 'none' then '44444444-4444-4444-8444-444444444494'::uuid
         when 'usd' then '44444444-4444-4444-8444-444444444495'::uuid
         when 'other' then '44444444-4444-4444-8444-444444444496'::uuid
       end,
       starts_at, starts_at + minutes * interval '1 minute', status
  from expected;

create temp table seeded (
  seq        int primary key,
  n          int not null,
  instructor text not null,
  period     int not null,
  amount     numeric not null,
  flags      text[] not null,
  rate       numeric,
  rate_unit  text not null default 'hour',
  minutes    int not null default 90,
  currency   text not null default 'CAD',
  lesson     text
);

insert into seeded (seq, n, instructor, period, amount, flags, rate) values
  (1,  6,  'ada', 1,   60, '{}', 40),
  (2,  7,  'ada', 1,   60, '{}', 40),
  (3,  8,  'ada', 1,    0, '{needs_rate}', null),
  (4,  10, 'ada', 1,   60, '{}', 40),
  (5,  10, 'ada', 2,  -60, '{late_cancel}', 40),
  (6,  11, 'ada', 1,   60, '{}', 40),
  (7,  11, 'ada', 2,    0, '{already_paid}', 50),
  (8,  12, 'ada', 1,   60, '{}', 40),
  (9,  13, 'ada', 1,    0, '{already_paid}', 40),
  (10, 14, 'ada', 2,  -60, '{late_cancel}', 40),
  (11, 14, 'ada', 1,    0, '{already_paid}', 50),
  (12, 14, 'ada', 4,  120, '{late}', 40),
  (13, 15, 'ada', 1,   60, '{}', 40),
  (14, 15, 'ada', 2,   60, '{late}', 40),
  (15, 16, 'ada', 1,   60, '{}', 40),
  (16, 17, 'ada', 1,   60, '{}', 40),
  (17, 17, 'ada', 2,  -60, '{late_cancel,reassigned}', 40),
  (18, 17, 'bo',  2,  120, '{late,reassigned}', 80),
  (19, 18, 'ada', 1,   60, '{}', 40),
  (20, 18, 'ada', 2,  -60, '{late_cancel,reassigned}', 40),
  (21, 18, 'bo',  2,  120, '{late,reassigned}', 80),
  (22, 19, 'ada', 1,   60, '{}', 40),
  (23, 19, 'ada', 2,  -60, '{late_cancel,reassigned}', 40),
  (24, 19, 'bo',  2,  120, '{late,reassigned}', 80),
  (25, 20, 'ada', 1,   60, '{}', 40),
  (26, 20, 'ada', 2,  -60, '{late_cancel,reassigned}', 40),
  (27, 20, 'bo',  2,  120, '{late,reassigned}', 80),
  (28, 20, 'bo',  4, -120, '{late_cancel}', 80),
  (29, 21, 'ada', 1,   60, '{}', 40),
  (30, 22, 'ada', 1,   60, '{}', 40),
  (31, 23, 'ada', 2,  -60, '{late_cancel}', 40),
  (32, 23, 'ada', 4,   60, '{late}', 40),
  (33, 23, 'ada', 1,    0, '{already_paid}', 50),
  (34, 24, 'ada', 2,  -60, '{late_cancel,reassigned}', 40),
  (35, 24, 'bo',  2,  120, '{late,reassigned}', 80),
  (36, 24, 'ada', 4,   60, '{late,reassigned}', 40),
  (37, 24, 'bo',  4, -120, '{late_cancel,reassigned}', 80),
  (38, 24, 'ada', 1,    0, '{already_paid}', 50),
  (39, 25, 'ada', 1,   60, '{}', 40),
  (40, 25, 'ada', 2,  -60, '{late_cancel,reassigned}', 40),
  (41, 25, 'bo',  2,  120, '{late,reassigned}', 80),
  (42, 26, 'ada', 1,   60, '{}', 40),
  (43, 26, 'ada', 2,  -60, '{late_cancel}', 40);

insert into seeded (seq, n, instructor, period, amount, flags, rate, rate_unit) values
  (44, 27, 'ada', 1,  200, '{}', 200, 'day'),
  (45, 28, 'ada', 1,  200, '{}', 200, 'day'),
  (46, 28, 'ada', 2,  200, '{late}', 200, 'day');

insert into seeded (seq, n, instructor, period, amount, flags, rate, rate_unit, minutes, currency, lesson) values
  (47, 29, 'ada', 1,   60, '{}', 40, 'hour', 90, 'CAD', null),
  (48, 30, 'ada', 1,   60, '{}', 40, 'hour', 90, 'CAD', null),
  (49, 31, 'ada', 1,   60, '{}', 40, 'hour', 90, 'CAD', null),
  (50, 31, 'ada', 2,   20, '{adjusted,changed_length}', 40, 'hour', 30, 'CAD', null),
  (51, 32, 'ada', 1,   60, '{}', 40, 'hour', 90, 'CAD', 'p90'),
  (52, 33, 'ada', 1,  200, '{}', 200, 'day', 360, 'CAD', null),
  (53, 34, 'ada', 2,   60, '{}', 40, 'hour', 90, 'CAD', null),
  (54, 35, 'ada', 2,   75, '{}', 50, 'hour', 90, 'CAD', null),
  (55, 36, 'ada', 2,   60, '{}', 40, 'hour', 90, 'CAD', null),
  (56, 37, 'ada', 2,   75, '{}', 50, 'hour', 90, 'CAD', null),
  (57, 38, 'ada', 2,   60, '{}', 40, 'hour', 90, 'CAD', null),
  (58, 39, 'cy',  1, 52.5, '{}', 35, 'hour', 90, 'CAD', null),
  (59, 40, 'cy',  1,   45, '{}', 30, 'hour', 90, 'CAD', null),
  (60, 41, 'ada', 1,   60, '{}', 40, 'hour', 90, 'CAD', 'p90'),
  (61, 42, 'ada', 1,   60, '{}', 40, 'hour', 90, 'CAD', 'p90'),
  (62, 42, 'ada', 2,  -60, '{adjusted,changed_lesson_type}', 40, 'hour', -90, 'CAD', 'p90'),
  (63, 42, 'ada', 2,   75, '{adjusted,changed_lesson_type}', 50, 'hour', 90, 'USD', null),
  (64, 43, 'ada', 1,    0, '{needs_rate}', null, 'hour', 60, 'CAD', null),
  (65, 44, 'ada', 1,   60, '{}', 60, 'hour', 60, 'CAD', 'p90'),
  (66, 45, 'ada', 1,   60, '{}', 40, 'hour', 90, 'CAD', 'p90'),
  (67, 46, 'ada', 1,   60, '{}', 40, 'hour', 90, 'CAD', null),
  (68, 46, 'ada', 2,   20, '{adjusted,changed_length}', 40, 'hour', 30, 'CAD', null),
  (69, 47, 'ada', 1,  200, '{}', 200, 'day', 90, 'USD', null),
  (70, 48, 'ada', 1,   60, '{}', 40, 'hour', 90, 'CAD', 'p90'),
  (71, 49, 'ada', 1,   60, '{}', 40, 'hour', 90, 'CAD', 'p90'),
  (72, 49, 'ada', 2,  -15, '{adjusted,changed_lesson_type}', 30, 'hour', 0, 'CAD', null),
  (73, 50, 'ada', 1,   60, '{}', 40, 'hour', 90, 'CAD', null),
  (74, 50, 'ada', 2,  -15, '{adjusted,changed_lesson_type}', 30, 'hour', 0, 'CAD', 'other'),
  (75, 51, 'ada', 1,   60, '{}', 40, 'hour', 90, 'CAD', 'p90'),
  (76, 51, 'ada', 2,   30, '{adjusted,changed_lesson_type}', 60, 'hour', 0, 'CAD', null);

insert into payroll_lines (
  period_id, instructor_id, class_id, kind, lesson_type_id, amount, flags, minutes,
  hourly_rate, rate_unit, currency, created_at
)
select ('66666666-6666-4666-8666-66666666660' || s.period)::uuid,
       case s.instructor
         when 'ada' then '22222222-2222-4222-8222-222222222292'::uuid
         when 'bo' then '22222222-2222-4222-8222-222222222293'::uuid
         else '22222222-2222-4222-8222-222222222294'::uuid
       end,
       ('55555555-5555-4555-8555-' || lpad(s.n::text, 12, '0'))::uuid,
       'class', c.lesson_type_id, s.amount, s.flags, s.minutes, s.rate, s.rate_unit, s.currency,
       timestamptz '2026-01-01 00:00Z' + s.seq * interval '1 minute'
  from seeded s
  join classes c on c.id = ('55555555-5555-4555-8555-' || lpad(s.n::text, 12, '0'))::uuid
 where s.lesson is null
union all
select ('66666666-6666-4666-8666-66666666660' || s.period)::uuid,
       '22222222-2222-4222-8222-222222222292'::uuid,
       ('55555555-5555-4555-8555-' || lpad(s.n::text, 12, '0'))::uuid,
       'class',
       case s.lesson
         when 'p90' then '44444444-4444-4444-8444-444444444492'::uuid
         when 'other' then '44444444-4444-4444-8444-444444444496'::uuid
       end,
       s.amount, s.flags, s.minutes, s.rate, s.rate_unit, s.currency,
       timestamptz '2026-01-01 00:00Z' + s.seq * interval '1 minute'
  from seeded s
 where s.lesson is not null;

update payroll_periods
   set status = 'finalized', finalized_at = now()
 where id in ('66666666-6666-4666-8666-666666666601', '66666666-6666-4666-8666-666666666602',
              '66666666-6666-4666-8666-666666666604');

do $$
declare
  r record;
  got boolean;
  zone text;
begin
  foreach zone in array array['UTC', 'Asia/Tokyo', 'America/Toronto'] loop
    perform set_config('timezone', zone, true);
    for r in select * from expected order by n loop
      got := exists (
        select 1 from public.payroll_unsettled_class_ids() u
         where u.class_id = ('55555555-5555-4555-8555-' || lpad(r.n::text, 12, '0'))::uuid
      );
      if got <> r.unsettled then
        raise exception 'case % (%) in %: expected unsettled=%, got %',
          r.n, r.label, zone, r.unsettled, got;
      end if;
    end loop;
  end loop;

  begin
    insert into payroll_lines (period_id, instructor_id, class_id, kind, amount)
    values ('66666666-6666-4666-8666-666666666603', '22222222-2222-4222-8222-222222222293',
            '55555555-5555-4555-8555-000000000014', 'class', 1);
    insert into payroll_lines (period_id, instructor_id, class_id, kind, amount)
    values ('66666666-6666-4666-8666-666666666603', '22222222-2222-4222-8222-222222222293',
            '55555555-5555-4555-8555-000000000014', 'class', 1);
    raise exception 'two lines for one class, instructor and currency in one period were accepted';
  exception when unique_violation then null;
  end;

  insert into payroll_lines (period_id, instructor_id, class_id, kind, amount, currency)
  values ('66666666-6666-4666-8666-666666666603', '22222222-2222-4222-8222-222222222292',
          '55555555-5555-4555-8555-000000000041', 'class', 60, 'CAD'),
         ('66666666-6666-4666-8666-666666666603', '22222222-2222-4222-8222-222222222292',
          '55555555-5555-4555-8555-000000000041', 'class', -60, 'USD');

  begin
    insert into payroll_lines (period_id, instructor_id, class_id, kind, amount, minutes)
    values ('66666666-6666-4666-8666-666666666603', '22222222-2222-4222-8222-222222222293',
            '55555555-5555-4555-8555-000000000030', 'class', -20, -30);
    raise exception 'negative minutes on a line that is not an adjustment were accepted';
  exception when check_violation then null;
  end;

  perform public.payroll_finalize(
    '66666666-6666-4666-8666-666666666603',
    jsonb_build_array(jsonb_build_object(
      'instructor_id', '22222222-2222-4222-8222-222222222292',
      'class_id', '55555555-5555-4555-8555-000000000030',
      'class_status', 'completed', 'minutes', -30, 'hourly_rate', 40,
      'currency', 'CAD', 'amount', -20, 'flags', array['adjusted', 'changed_length']
    )),
    null
  );
  if exists (
    select 1 from public.payroll_unsettled_class_ids() u
     where u.class_id = '55555555-5555-4555-8555-000000000030'
  ) then
    raise exception 'a finalized adjustment with negative minutes did not settle its lesson';
  end if;

  if has_function_privilege('anon', 'public.payroll_unsettled_class_ids()', 'execute')
     or has_function_privilege('authenticated', 'public.payroll_unsettled_class_ids()', 'execute') then
    raise exception 'payroll_unsettled_class_ids is executable by a client role';
  end if;
end
$$;

rollback;
\echo 'Payroll unsettled class checks passed.'
