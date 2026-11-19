\set ON_ERROR_STOP on
begin;

insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111192', 'ci-unsettled-ada@example.com'),
  ('11111111-1111-4111-8111-111111111193', 'ci-unsettled-bo@example.com');
insert into instructors (id, auth_user_id, email, display_name_en) values
  ('22222222-2222-4222-8222-222222222292', '11111111-1111-4111-8111-111111111192', 'ci-unsettled-ada@example.com', 'CI Ada'),
  ('22222222-2222-4222-8222-222222222293', '11111111-1111-4111-8111-111111111193', 'ci-unsettled-bo@example.com', 'CI Bo');
insert into lesson_types (id, name_en, group_size, duration_min)
values ('44444444-4444-4444-8444-444444444492', 'Unsettled Private 90', 1, 90);
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
  unsettled  boolean not null
);

insert into expected values
  (1,  '23:30 Toronto on the last day of a finalized period',      'ada', '2026-01-11 23:30 America/Toronto', 'completed', true),
  (2,  '00:00 Toronto on the first day of an open period',         'ada', '2026-01-12 00:00 America/Toronto', 'completed', false),
  (3,  '00:00 Toronto on the first day of a finalized period',     'ada', '2025-12-15 00:00 America/Toronto', 'completed', true),
  (4,  '23:59 Toronto the day before any period',                  'ada', '2025-12-14 23:59 America/Toronto', 'completed', false),
  (5,  'cancelled, never paid',                                    'ada', '2025-12-16 10:00 America/Toronto', 'cancelled', false),
  (6,  'paid and settled',                                         'ada', '2025-12-17 10:00 America/Toronto', 'completed', false),
  (7,  'paid, then cancelled',                                     'ada', '2025-12-18 10:00 America/Toronto', 'cancelled', true),
  (8,  'paid zero with needs_rate',                                'ada', '2025-12-19 10:00 America/Toronto', 'completed', false),
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
  (26, 'Ada paid and reversed, moved into an open period on Bo',   'bo',  '2026-01-17 10:00 America/Toronto', 'completed', false),
  (27, 'paid at a daily rate and settled',                         'ada', '2025-12-17 13:00 America/Toronto', 'completed', false),
  (28, 'paid at a daily rate, then paid again',                    'ada', '2025-12-17 14:00 America/Toronto', 'completed', true);

insert into classes (id, instructor_id, lesson_type_id, starts_at, ends_at, status)
select ('55555555-5555-4555-8555-' || lpad(n::text, 12, '0'))::uuid,
       case instructor
         when 'ada' then '22222222-2222-4222-8222-222222222292'::uuid
         else '22222222-2222-4222-8222-222222222293'::uuid
       end,
       '44444444-4444-4444-8444-444444444492', starts_at, starts_at + interval '90 minutes', status
  from expected;

create temp table seeded (
  seq        int primary key,
  n          int not null,
  instructor text not null,
  period     int not null,
  amount     numeric not null,
  flags      text[] not null,
  rate       numeric,
  rate_unit  text not null default 'hour'
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

insert into payroll_lines (
  period_id, instructor_id, class_id, kind, amount, flags, minutes,
  hourly_rate, rate_unit, created_at
)
select ('66666666-6666-4666-8666-66666666660' || s.period)::uuid,
       case s.instructor
         when 'ada' then '22222222-2222-4222-8222-222222222292'::uuid
         else '22222222-2222-4222-8222-222222222293'::uuid
       end,
       ('55555555-5555-4555-8555-' || lpad(s.n::text, 12, '0'))::uuid,
       'class', s.amount, s.flags, 90, s.rate, s.rate_unit,
       timestamptz '2026-01-01 00:00Z' + s.seq * interval '1 minute'
  from seeded s;

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
    raise exception 'two lines for one class and instructor in one period were accepted';
  exception when unique_violation then null;
  end;

  if has_function_privilege('anon', 'public.payroll_unsettled_class_ids()', 'execute')
     or has_function_privilege('authenticated', 'public.payroll_unsettled_class_ids()', 'execute') then
    raise exception 'payroll_unsettled_class_ids is executable by a client role';
  end if;
end
$$;

rollback;
\echo 'Payroll unsettled class checks passed.'
