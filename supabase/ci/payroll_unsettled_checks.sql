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
  ('66666666-6666-4666-8666-666666666603', '2026-01-12', '2026-01-25');

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
  (14, 'top-up after a reopen settles at the net it reached',      'ada', '2025-12-24 10:00 America/Toronto', 'completed', false),
  (15, 'paid twice, still active',                                 'ada', '2025-12-25 10:00 America/Toronto', 'completed', true),
  (16, 'paid to Ada, now on Bo',                                   'bo',  '2025-12-26 10:00 America/Toronto', 'completed', true),
  (17, 'reassignment settled: Ada 0, Bo paid',                     'bo',  '2025-12-27 10:00 America/Toronto', 'completed', false),
  (18, 'reassignment settled, then back on Ada',                   'ada', '2025-12-28 10:00 America/Toronto', 'completed', true),
  (19, 'reassignment settled, then cancelled',                     'bo',  '2025-12-29 10:00 America/Toronto', 'cancelled', true),
  (20, 'reassignment settled, cancelled and reversed',             'bo',  '2025-12-30 10:00 America/Toronto', 'cancelled', false),
  (21, 'paid to Ada, moved into an open period on Bo',             'bo',  '2026-01-14 10:00 America/Toronto', 'completed', false),
  (22, 'paid to Ada, moved into an open period on Bo, cancelled',  'bo',  '2026-01-15 10:00 America/Toronto', 'cancelled', true);

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
  flags      text[] not null
);

insert into seeded values
  (1,  6,  'ada', 1,   60, '{}'),
  (2,  7,  'ada', 1,   60, '{}'),
  (3,  8,  'ada', 1,    0, '{needs_rate}'),
  (4,  10, 'ada', 1,   60, '{}'),
  (5,  10, 'ada', 2,  -60, '{late_cancel}'),
  (6,  11, 'ada', 1,   60, '{}'),
  (7,  11, 'ada', 2,    0, '{already_paid}'),
  (8,  12, 'ada', 1,   60, '{}'),
  (9,  13, 'ada', 1,    0, '{already_paid}'),
  (10, 14, 'ada', 2,  -60, '{late_cancel}'),
  (11, 14, 'ada', 1,    0, '{already_paid}'),
  (12, 14, 'ada', 3,  120, '{late}'),
  (13, 15, 'ada', 1,   60, '{}'),
  (14, 15, 'ada', 2,   60, '{late}'),
  (15, 16, 'ada', 1,   60, '{}'),
  (16, 17, 'ada', 1,   60, '{}'),
  (17, 17, 'ada', 2,  -60, '{late_cancel,reassigned}'),
  (18, 17, 'bo',  2,  120, '{late,reassigned}'),
  (19, 18, 'ada', 1,   60, '{}'),
  (20, 18, 'ada', 2,  -60, '{late_cancel,reassigned}'),
  (21, 18, 'bo',  2,  120, '{late,reassigned}'),
  (22, 19, 'ada', 1,   60, '{}'),
  (23, 19, 'ada', 2,  -60, '{late_cancel,reassigned}'),
  (24, 19, 'bo',  2,  120, '{late,reassigned}'),
  (25, 20, 'ada', 1,   60, '{}'),
  (26, 20, 'ada', 2,  -60, '{late_cancel,reassigned}'),
  (27, 20, 'bo',  2,  120, '{late,reassigned}'),
  (28, 20, 'bo',  3, -120, '{late_cancel}'),
  (29, 21, 'ada', 1,   60, '{}'),
  (30, 22, 'ada', 1,   60, '{}');

insert into payroll_lines (
  period_id, instructor_id, class_id, kind, amount, flags, created_at
)
select ('66666666-6666-4666-8666-66666666660' || s.period)::uuid,
       case s.instructor
         when 'ada' then '22222222-2222-4222-8222-222222222292'::uuid
         else '22222222-2222-4222-8222-222222222293'::uuid
       end,
       ('55555555-5555-4555-8555-' || lpad(s.n::text, 12, '0'))::uuid,
       'class', s.amount, s.flags,
       timestamptz '2026-01-01 00:00Z' + s.seq * interval '1 minute'
  from seeded s;

update payroll_periods
   set status = 'finalized', finalized_at = now()
 where id in ('66666666-6666-4666-8666-666666666601', '66666666-6666-4666-8666-666666666602');

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
