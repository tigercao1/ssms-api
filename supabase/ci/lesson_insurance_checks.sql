\set ON_ERROR_STOP on
begin;

insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-1111111111a1', 'ci-ins-a@example.com'),
  ('11111111-1111-4111-8111-1111111111a2', 'ci-ins-b@example.com');
insert into instructors (id, auth_user_id, email, display_name_en) values
  ('22222222-2222-4222-8222-2222222222a1', '11111111-1111-4111-8111-1111111111a1', 'ci-ins-a@example.com', 'CI Insurance A'),
  ('22222222-2222-4222-8222-2222222222a2', '11111111-1111-4111-8111-1111111111a2', 'ci-ins-b@example.com', 'CI Insurance B');
insert into teaching_locations (id, key, name)
values ('33333333-3333-4333-8333-3333333333a1', 'teaching_location.ci_insurance', 'CI Hill');
insert into seasons (key, starts_on, ends_on) values ('2027/28', '2027-11-01', '2028-04-30');

create function pg_temp.students(n int) returns jsonb language sql as $$
  select jsonb_agg(jsonb_build_object('name', 'Student ' || i, 'waiverConfirmed', true))
    from generate_series(1, n) i;
$$;

create function pg_temp.lesson(
  p_instructor uuid, p_date date, p_hours int, p_students int,
  p_top_up boolean default false, p_key uuid default gen_random_uuid()
) returns jsonb language sql as $$
  select public.lesson_insurance_register(
    p_instructor, 'lesson', null, p_date, p_hours,
    '33333333-3333-4333-8333-3333333333a1', null, pg_temp.students(p_students),
    p_top_up, p_key, null
  );
$$;

create function pg_temp.pass(p_instructor uuid, p_season text) returns jsonb language sql as $$
  select public.lesson_insurance_register(
    p_instructor, 'season_pass', p_season, null, null, null, null, null,
    false, gen_random_uuid(), null
  );
$$;

create function pg_temp.rec(p jsonb) returns lesson_insurance_records language sql as $$
  select * from lesson_insurance_records where id = (p ->> 'id')::uuid;
$$;

create function pg_temp.owed(p_instructor uuid, p_season text) returns int language sql as $$
  select coalesce(sum(amount_cents), 0)::int from lesson_insurance_records
   where instructor_id = p_instructor and season_key = p_season and payment_status <> 'voided';
$$;

do $$
declare
  a constant uuid := '22222222-2222-4222-8222-2222222222a1';
  b constant uuid := '22222222-2222-4222-8222-2222222222a2';
  k uuid := gen_random_uuid();
  r jsonb;
  first_id uuid;
  rec lesson_insurance_records;
  n int;
  base int := coalesce((select last_no from lesson_insurance_record_counters
                         where day = (now() at time zone 'America/Toronto')::date), 0);
begin
  r := pg_temp.lesson(a, '2026-12-01', 1, 6, false, k);
  rec := pg_temp.rec(r);
  if r ->> 'outcome' <> 'created' or rec.list_cents <> 4000 or rec.amount_cents <> 4000
     or rec.student_count <> 6 or rec.coverage <> 'per_lesson' or rec.payment_status <> 'unpaid'
     or rec.season_key <> '2026/27' then
    raise exception '6 students for an hour should be a 4-student per_lesson 4000: % %', r, rec;
  end if;
  first_id := rec.id;

  r := pg_temp.lesson(a, '2026-12-01', 2, 1, false, k);
  if r ->> 'outcome' <> 'existing' or (r ->> 'id')::uuid <> first_id then
    raise exception 'a repeated idempotency key did not return the existing record: %', r;
  end if;
  if (select count(*) from lesson_insurance_records where instructor_id = a) <> 1 then
    raise exception 'a repeated idempotency key created a record';
  end if;

  for i in 1..4 loop
    perform pg_temp.lesson(a, ('2027-01-0' || i)::date, 2, 4);
  end loop;
  perform pg_temp.lesson(a, '2027-01-10', 1, 2);
  if pg_temp.owed(a, '2026/27') <> 38000 then
    raise exception 'owed should be 38000, got %', pg_temp.owed(a, '2026/27');
  end if;

  r := pg_temp.lesson(a, '2027-02-01', 1, 2);
  if r ->> 'outcome' <> 'cap_reached' or (r ->> 'list_cents')::int <> 2000
     or (r ->> 'owed_cents')::int <> 38000 or (r ->> 'top_up_cents')::int <> 2000 then
    raise exception '380 owed + 20 list should be cap_reached with a 20 top-up: %', r;
  end if;
  if pg_temp.owed(a, '2026/27') <> 38000 then
    raise exception 'cap_reached created a record';
  end if;

  r := pg_temp.lesson(a, '2027-02-01', 1, 2, true);
  rec := pg_temp.rec(r);
  if rec.amount_cents <> 2000 or rec.list_cents <> 2000 or rec.coverage <> 'cap_top_up'
     or rec.payment_status <> 'unpaid' then
    raise exception 'the top-up should be 2000 cap_top_up: %', rec;
  end if;

  r := pg_temp.lesson(a, '2027-02-02', 2, 3);
  rec := pg_temp.rec(r);
  if rec.amount_cents <> 0 or rec.list_cents <> 6000 or rec.coverage <> 'capped'
     or rec.payment_status <> 'not_required' then
    raise exception 'a capped lesson should be free and capped: %', rec;
  end if;

  r := pg_temp.pass(a, '2026/27');
  if r ->> 'outcome' <> 'already_covered' or (r ->> 'owed_cents')::int <> 40000 then
    raise exception 'a pass on a capped season should be already_covered: %', r;
  end if;
  if pg_temp.owed(a, '2026/27') <> 40000 then
    raise exception 'owed should stay at the cap, got %', pg_temp.owed(a, '2026/27');
  end if;

  r := pg_temp.lesson(a, '2027-05-15', 1, 1);
  if r ->> 'outcome' <> 'no_season' then
    raise exception 'a date after 2027-04-30 should have no season: %', r;
  end if;
  r := pg_temp.lesson(a, '2027-12-01', 2, 2);
  rec := pg_temp.rec(r);
  if rec.season_key <> '2027/28' or rec.amount_cents <> 4000 or rec.coverage <> 'per_lesson' then
    raise exception 'a lesson in 2027/28 should start that season from 0: %', rec;
  end if;

  perform pg_temp.lesson(b, '2026-11-15', 1, 1);
  r := pg_temp.pass(b, '2026/27');
  rec := pg_temp.rec(r);
  if rec.kind <> 'season_pass' or rec.amount_cents <> 39000 or rec.list_cents <> 40000
     or rec.coverage is not null or rec.lesson_date is not null or rec.students is not null
     or rec.payment_status <> 'unpaid' then
    raise exception 'a season pass should cost 400 - owed with no lesson fields: %', rec;
  end if;
  r := pg_temp.lesson(b, '2026-11-20', 2, 5);
  rec := pg_temp.rec(r);
  if rec.amount_cents <> 0 or rec.coverage <> 'season_pass' or rec.payment_status <> 'not_required' then
    raise exception 'a lesson under a season pass should be free with season_pass coverage: %', rec;
  end if;
  r := pg_temp.pass(b, '2099/00');
  if r ->> 'outcome' <> 'no_season' then
    raise exception 'a pass for an unknown season should have no season: %', r;
  end if;

  update lesson_insurance_records
     set payment_status = 'voided', voided_at = now(), voided_reason = 'CI',
         voided_from_status = payment_status
   where id = first_id;
  if pg_temp.owed(a, '2026/27') <> 36000 then
    raise exception 'a voided record should leave the total';
  end if;
  if (select amount_cents from lesson_insurance_records
       where instructor_id = a and coverage = 'capped') <> 0 then
    raise exception 'voiding recomputed a later record';
  end if;
  r := pg_temp.lesson(a, '2027-03-01', 1, 1);
  if (pg_temp.rec(r)).amount_cents <> 1000 then
    raise exception 'after a void the next lesson should be charged again';
  end if;

  if exists (
    select 1 from lesson_insurance_records
     group by instructor_id, season_key
    having sum(amount_cents) filter (where payment_status <> 'voided') > 40000
  ) then
    raise exception 'an instructor owes more than 40000 in a season';
  end if;

  select count(*) into n from lesson_insurance_records where instructor_id in (a, b);
  if exists (select 1 from lesson_insurance_records where instructor_id in (a, b) and record_no !~ ('^INS-' || to_char((now() at time zone 'America/Toronto')::date, 'YYYYMMDD') || '-\d{4}$')) then
    raise exception 'record_no is not INS-<Toronto creation date>-NNNN';
  end if;
  if (select array_agg(right(record_no, 4)::int order by record_no) from lesson_insurance_records
       where instructor_id in (a, b))
     <> (select array_agg(i) from generate_series(base + 1, base + n) i) then
    raise exception 'record numbers are not a per-day sequence from 0001';
  end if;
  if (select last_no from lesson_insurance_record_counters
       where day = (now() at time zone 'America/Toronto')::date) <> base + n then
    raise exception 'the day counter does not match the records issued';
  end if;

  begin
    perform public.lesson_insurance_register(
      b, 'lesson', null, '2027-12-02', 1, null, null,
      '[{"name": "Ada", "waiverConfirmed": false}]'::jsonb, false, gen_random_uuid(), null);
    raise exception 'an unconfirmed waiver was accepted';
  exception when check_violation then null;
  end;
  begin
    perform public.lesson_insurance_register(
      b, 'lesson', null, '2027-12-02', 1, null, null,
      '[{"name": " Ada", "waiverConfirmed": true}]'::jsonb, false, gen_random_uuid(), null);
    raise exception 'an untrimmed student name was accepted';
  exception when check_violation then null;
  end;
  begin
    perform public.lesson_insurance_register(
      b, 'lesson', null, '2027-12-02', 1, null, null, '[]'::jsonb, false, gen_random_uuid(), null);
    raise exception 'a lesson without students was accepted';
  exception when check_violation then null;
  end;
  begin
    perform public.lesson_insurance_register(
      b, 'lesson', null, '2027-12-02', 3, null, null, pg_temp.students(1), false, gen_random_uuid(), null);
    raise exception 'a 3-hour lesson was accepted';
  exception when check_violation then null;
  end;
  begin
    perform public.lesson_insurance_register(
      b, 'lesson', null, '2027-12-02', 1, '33333333-3333-4333-8333-3333333333a1', 'Elsewhere',
      pg_temp.students(1), false, gen_random_uuid(), null);
    raise exception 'a lesson with both a location and another location was accepted';
  exception when check_violation then null;
  end;
  begin
    perform public.lesson_insurance_register(
      b, 'lesson', null, '2027-12-02', 1, gen_random_uuid(), null,
      pg_temp.students(1), false, gen_random_uuid(), null);
    raise exception 'an unknown location was accepted';
  exception when foreign_key_violation then null;
  end;
  begin
    perform public.lesson_insurance_register(
      a, 'refund', null, '2027-03-02', 1, null, null, null, false, gen_random_uuid(), null);
    raise exception 'an unknown kind was accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    update lesson_insurance_records set lesson_date = '2027-01-01'
     where instructor_id = b and kind = 'season_pass';
    raise exception 'a season pass with a lesson date was accepted';
  exception when check_violation then null;
  end;
  begin
    update lesson_insurance_records set amount_cents = 40001 where id = first_id;
    raise exception 'an amount above 40000 was accepted';
  exception when check_violation then null;
  end;
  begin
    update lesson_insurance_records set payment_status = 'paid' where id = first_id;
    raise exception 'a paid record without paid_on was accepted';
  exception when check_violation then null;
  end;
  begin
    delete from seasons where key = '2027/28';
    raise exception 'a season with insurance records was deleted';
  exception when foreign_key_violation then null;
  end;
end
$$;

do $$
declare
  t text;
  r text;
begin
  foreach t in array array['lesson_insurance_records', 'lesson_insurance_record_counters'] loop
    if not (select relrowsecurity and relforcerowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception '% does not have forced row level security', t;
    end if;
    foreach r in array array['anon', 'authenticated'] loop
      if has_table_privilege(r, 'public.' || t, 'select, insert, update, delete') then
        raise exception '% has privileges on %', r, t;
      end if;
    end loop;
  end loop;
  foreach r in array array['anon', 'authenticated'] loop
    if has_function_privilege(r, 'public.lesson_insurance_register(uuid, text, text, date, int, uuid, text, jsonb, boolean, uuid, uuid)', 'execute') then
      raise exception '% can execute lesson_insurance_register', r;
    end if;
  end loop;
end
$$;

rollback;

create extension if not exists dblink;

insert into auth.users (id, email)
values ('11111111-1111-4111-8111-1111111111a3', 'ci-ins-c@example.com');
insert into instructors (id, auth_user_id, email, display_name_en)
values ('22222222-2222-4222-8222-2222222222a3', '11111111-1111-4111-8111-1111111111a3', 'ci-ins-c@example.com', 'CI Insurance C');
do $$
begin
  perform public.lesson_insurance_register(
    '22222222-2222-4222-8222-2222222222a3', 'lesson', null, ('2026-12-0' || i)::date, 2, null, null,
    '[{"name": "A", "waiverConfirmed": true}, {"name": "B", "waiverConfirmed": true}, {"name": "C", "waiverConfirmed": true}, {"name": "D", "waiverConfirmed": true}]'::jsonb,
    false, gen_random_uuid(), null)
    from generate_series(1, 4) i;
  perform public.lesson_insurance_register(
    '22222222-2222-4222-8222-2222222222a3', 'lesson', null, date '2026-12-05', 2, null, null,
    '[{"name": "A", "waiverConfirmed": true}, {"name": "B", "waiverConfirmed": true}]'::jsonb,
    false, gen_random_uuid(), null);
end
$$;

do $$
declare
  c constant uuid := '22222222-2222-4222-8222-2222222222a3';
  conn text := 'dbname=' || current_database()
    || ' user=' || current_user
    || ' port=' || current_setting('port')
    || ' host=' || split_part(current_setting('unix_socket_directories'), ',', 1);
  call text := format(
    'select public.lesson_insurance_register(%L, ''lesson'', null, date ''2027-01-15'', 2, null, null, '
    || '''[{"name": "A", "waiverConfirmed": true}, {"name": "B", "waiverConfirmed": true}]''::jsonb, true, gen_random_uuid(), null)::text',
    c);
  first jsonb;
  second jsonb;
begin
  if (select sum(amount_cents) from lesson_insurance_records where instructor_id = c) <> 36000 then
    raise exception 'concurrency fixture should owe 36000';
  end if;
  perform dblink_connect('ins_one', conn);
  perform dblink_connect('ins_two', conn);
  perform dblink_exec('ins_one', 'begin');
  select r::jsonb into first from dblink('ins_one', call) as t(r text);
  perform dblink_send_query('ins_two', call);
  perform pg_sleep(0.5);
  if dblink_is_busy('ins_two') <> 1 then
    raise exception 'the second registration did not wait for the first';
  end if;
  perform dblink_exec('ins_one', 'commit');
  select r::jsonb into second from dblink_get_result('ins_two') as t(r text);
  perform dblink_disconnect('ins_one');
  perform dblink_disconnect('ins_two');

  if (select amount_cents from lesson_insurance_records where id = (first ->> 'id')::uuid) <> 4000
     or (select coverage from lesson_insurance_records where id = (first ->> 'id')::uuid) <> 'cap_top_up' then
    raise exception 'the first concurrent registration should top up 4000: %', first;
  end if;
  if (select amount_cents from lesson_insurance_records where id = (second ->> 'id')::uuid) <> 0
     or (select coverage from lesson_insurance_records where id = (second ->> 'id')::uuid) <> 'capped' then
    raise exception 'the second concurrent registration should be capped at 0: %', second;
  end if;
  if (select sum(amount_cents) from lesson_insurance_records where instructor_id = c) <> 40000 then
    raise exception 'two parallel registrations exceeded the cap';
  end if;
end
$$;

delete from lesson_insurance_records where instructor_id = '22222222-2222-4222-8222-2222222222a3';
delete from instructors where id = '22222222-2222-4222-8222-2222222222a3';
delete from auth.users where id = '11111111-1111-4111-8111-1111111111a3';

\echo 'Lesson insurance checks passed.'
