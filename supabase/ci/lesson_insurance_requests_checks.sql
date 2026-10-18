\set ON_ERROR_STOP on
begin;

insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-1111111111b1', 'ci-req-a@example.com'),
  ('11111111-1111-4111-8111-1111111111b2', 'ci-req-b@example.com');
insert into instructors (id, auth_user_id, email, display_name_en) values
  ('22222222-2222-4222-8222-2222222222b1', '11111111-1111-4111-8111-1111111111b1', 'ci-req-a@example.com', 'CI Request A'),
  ('22222222-2222-4222-8222-2222222222b2', '11111111-1111-4111-8111-1111111111b2', 'ci-req-b@example.com', 'CI Request B');
insert into teaching_locations (id, key, name)
values ('33333333-3333-4333-8333-3333333333b1', 'teaching_location.ci_requests', 'CI Request Hill');
insert into seasons (key, starts_on, ends_on) values ('2027/28', '2027-11-01', '2028-04-30');

create function pg_temp.lesson(p_date date, p_hours int, p_students int, p_location uuid default null)
returns jsonb language sql as $$
  select jsonb_build_object(
    'lessonDate', p_date,
    'durationHours', p_hours,
    'locationId', p_location,
    'locationOther', null,
    'students', (select jsonb_agg(jsonb_build_object('name', 'Student ' || i, 'waiverConfirmed', true))
                   from generate_series(1, p_students) i)
  );
$$;

create function pg_temp.submit(p_instructor uuid, p_lessons jsonb, p_key uuid default gen_random_uuid())
returns jsonb language sql as $$
  select public.lesson_insurance_submit_request(p_instructor, null, p_lessons, p_key, null);
$$;

create function pg_temp.owed(p_instructor uuid, p_season text) returns int language sql as $$
  select coalesce(sum(amount_cents), 0)::int from lesson_insurance_records
   where instructor_id = p_instructor and season_key = p_season and payment_status <> 'voided';
$$;

create function pg_temp.counter() returns int language sql as $$
  select coalesce((select last_no from lesson_insurance_record_counters
                    where day = (now() at time zone 'America/Toronto')::date), 0);
$$;

do $$
declare
  a constant uuid := '22222222-2222-4222-8222-2222222222b1';
  k uuid := gen_random_uuid();
  r jsonb;
  req lesson_insurance_requests;
  amounts int[];
  coverages text[];
  statuses text[];
  base int;
  rows_before int;
begin
  for i in 1..4 loop
    perform public.lesson_insurance_register(
      a, 'lesson', null, ('2026-11-0' || i)::date, 2, null, null,
      (pg_temp.lesson('2026-11-01', 2, 4)) -> 'students', false, gen_random_uuid(), null);
  end loop;
  if pg_temp.owed(a, '2026/27') <> 32000 then
    raise exception 'fixture should owe 32000, got %', pg_temp.owed(a, '2026/27');
  end if;

  base := pg_temp.counter();
  r := pg_temp.submit(a, jsonb_build_array(
    pg_temp.lesson('2026-12-03', 1, 2, '33333333-3333-4333-8333-3333333333b1'),
    pg_temp.lesson('2026-12-01', 2, 4),
    pg_temp.lesson('2026-12-02', 1, 1)
  ), k);
  select * into req from lesson_insurance_requests where id = (r ->> 'id')::uuid;
  if r ->> 'outcome' <> 'created' or req.total_cents <> 8000 or req.payment_status <> 'unpaid'
     or req.lesson_count <> 3 or req.season_key <> '2026/27' or req.idempotency_key <> k
     or req.request_no <> 'INS-' || to_char((now() at time zone 'America/Toronto')::date, 'YYYYMMDD')
                         || '-' || lpad((base + 1)::text, 4, '0') then
    raise exception 'a request across the cap should total 8000 unpaid with the next number: % %', r, req;
  end if;
  select array_agg(amount_cents order by record_no), array_agg(coverage order by record_no),
         array_agg(payment_status order by record_no)
    into amounts, coverages, statuses
    from lesson_insurance_records where request_id = req.id;
  if amounts <> array[2000, 6000, 0] or coverages <> array['per_lesson', 'cap_top_up', 'capped']
     or statuses <> array['unpaid', 'unpaid', 'not_required'] then
    raise exception 'lessons should be priced in the order entered: % % %', amounts, coverages, statuses;
  end if;
  if (select array_agg(lesson_date order by record_no) from lesson_insurance_records where request_id = req.id)
     <> array['2026-12-03', '2026-12-01', '2026-12-02']::date[] then
    raise exception 'record numbers should follow the order entered';
  end if;
  if pg_temp.counter() <> base + 4 then
    raise exception 'a 3-lesson request should take 4 numbers, took %', pg_temp.counter() - base;
  end if;
  if pg_temp.owed(a, '2026/27') <> 40000 then
    raise exception 'owed should be exactly 40000, got %', pg_temp.owed(a, '2026/27');
  end if;

  rows_before := (select count(*) from lesson_insurance_records);
  r := pg_temp.submit(a, jsonb_build_array(pg_temp.lesson('2027-01-05', 2, 2)), k);
  if r ->> 'outcome' <> 'existing' or (r ->> 'id')::uuid <> req.id
     or (select count(*) from lesson_insurance_records) <> rows_before then
    raise exception 'a repeated idempotency key should return the existing request: %', r;
  end if;

  r := pg_temp.submit(a, jsonb_build_array(pg_temp.lesson('2027-01-05', 2, 2)));
  select * into req from lesson_insurance_requests where id = (r ->> 'id')::uuid;
  if req.total_cents <> 0 or req.payment_status <> 'not_required' then
    raise exception 'a request after the cap should be free: %', req;
  end if;
end
$$;

do $$
declare
  b constant uuid := '22222222-2222-4222-8222-2222222222b2';
  base int := pg_temp.counter();
  rows_before int := (select count(*) from lesson_insurance_records);
  reqs_before int := (select count(*) from lesson_insurance_requests);
  r jsonb;
begin
  begin
    perform pg_temp.submit(b, jsonb_build_array(
      pg_temp.lesson('2026-12-01', 1, 1),
      pg_temp.lesson('2026-12-02', 1, 1),
      pg_temp.lesson('2026-12-03', 1, 1, gen_random_uuid())
    ));
    raise exception 'an unknown location on lesson 3 was accepted';
  exception when foreign_key_violation then null;
  end;
  begin
    perform pg_temp.submit(b, jsonb_build_array(
      pg_temp.lesson('2026-12-01', 1, 1),
      pg_temp.lesson('2026-12-02', 1, 1),
      jsonb_set(pg_temp.lesson('2026-12-03', 1, 1), '{students,0,waiverConfirmed}', 'false')
    ));
    raise exception 'an unconfirmed waiver on lesson 3 was accepted';
  exception when check_violation then null;
  end;
  begin
    perform pg_temp.submit(b, jsonb_build_array(
      pg_temp.lesson('2026-12-01', 1, 1),
      pg_temp.lesson('2026-12-02', 1, 1),
      jsonb_set(pg_temp.lesson('2026-12-03', 1, 1), '{durationHours}', '3')
    ));
    raise exception 'a 3-hour lesson 3 was accepted';
  exception when check_violation then null;
  end;
  if (select count(*) from lesson_insurance_records) <> rows_before
     or (select count(*) from lesson_insurance_requests) <> reqs_before
     or pg_temp.counter() <> base then
    raise exception 'a failed request left records, a request or used numbers behind';
  end if;

  r := pg_temp.submit(b, (select jsonb_agg(pg_temp.lesson(('2026-12-01'::date + i), 1, 1)) from generate_series(0, 10) i));
  if r ->> 'outcome' <> 'too_many_lessons' or (r ->> 'lesson_count')::int <> 11 then
    raise exception '11 lessons should be too_many_lessons: %', r;
  end if;
  r := pg_temp.submit(b, (select jsonb_agg(pg_temp.lesson(('2026-12-01'::date + i), 1, 1)) from generate_series(0, 9) i));
  if r ->> 'outcome' <> 'created'
     or (select lesson_count from lesson_insurance_requests where id = (r ->> 'id')::uuid) <> 10
     or (select count(*) from lesson_insurance_records where request_id = (r ->> 'id')::uuid) <> 10 then
    raise exception '10 lessons should be one request of 10: %', r;
  end if;
  begin
    perform pg_temp.submit(b, '[]'::jsonb);
    raise exception 'an empty request was accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.lesson_insurance_submit_request(b, null, jsonb_build_array(pg_temp.lesson('2026-12-01', 1, 1)), null, null);
    raise exception 'a request without an idempotency key was accepted';
  exception when invalid_parameter_value then null;
  end;

  r := pg_temp.submit(b, jsonb_build_array(pg_temp.lesson('2026-12-01', 1, 1), pg_temp.lesson('2027-12-01', 1, 1)));
  if r ->> 'outcome' <> 'mixed_seasons' or (r ->> 'lesson_index')::int <> 1 or r ->> 'season_key' <> '2026/27' then
    raise exception 'two seasons should be mixed_seasons at index 1: %', r;
  end if;
  r := pg_temp.submit(b, jsonb_build_array(pg_temp.lesson('2026-12-01', 1, 1), pg_temp.lesson('2026-12-02', 1, 1), pg_temp.lesson('2027-05-15', 1, 1)));
  if r ->> 'outcome' <> 'no_season' or (r ->> 'lesson_index')::int <> 2 then
    raise exception 'a date without a season should be no_season at index 2: %', r;
  end if;
  r := public.lesson_insurance_submit_request(b, '2099/00', jsonb_build_array(pg_temp.lesson('2026-12-01', 1, 1)), gen_random_uuid(), null);
  if r ->> 'outcome' <> 'no_season' or r ? 'lesson_index' then
    raise exception 'an unknown season key should be no_season: %', r;
  end if;
  r := public.lesson_insurance_submit_request(b, '2027/28', jsonb_build_array(pg_temp.lesson('2026-12-01', 1, 1)), gen_random_uuid(), null);
  if r ->> 'outcome' <> 'mixed_seasons' or (r ->> 'lesson_index')::int <> 0 then
    raise exception 'a lesson outside the given season should be mixed_seasons: %', r;
  end if;
  if (select count(*) from lesson_insurance_requests) <> reqs_before + 1 then
    raise exception 'a rejected request was stored';
  end if;
end
$$;

do $$
declare
  b constant uuid := '22222222-2222-4222-8222-2222222222b2';
  admin_id constant uuid := '11111111-1111-4111-8111-1111111111b1';
  req_id uuid;
  free_id uuid;
  r jsonb;
  req lesson_insurance_requests;
  owed_before int;
begin
  req_id := (pg_temp.submit(b, jsonb_build_array(pg_temp.lesson('2027-12-01', 2, 4), pg_temp.lesson('2027-12-02', 1, 1))) ->> 'id')::uuid;
  update lesson_insurance_records set amount_cents = 0, coverage = 'capped', payment_status = 'not_required'
   where request_id = req_id and lesson_date = '2027-12-02';
  update lesson_insurance_requests set total_cents = 8000 where id = req_id;
  owed_before := pg_temp.owed(b, '2027/28');

  r := public.lesson_insurance_request_transition(req_id, 'mark_unpaid', admin_id, null, null, null);
  if r ->> 'outcome' <> 'conflict' or r ->> 'from' <> 'unpaid' then
    raise exception 'mark_unpaid on an unpaid request should conflict: %', r;
  end if;
  r := public.lesson_insurance_request_transition(req_id, 'mark_paid', admin_id, '2026-10-15', 'e-transfer', null);
  select * into req from lesson_insurance_requests where id = req_id;
  if r ->> 'outcome' <> 'updated' or req.payment_status <> 'paid' or req.paid_on <> '2026-10-15'
     or req.paid_note <> 'e-transfer' or req.paid_by <> admin_id then
    raise exception 'mark_paid should mark the request paid: % %', r, req;
  end if;
  if coalesce(r ->> 'from' <> 'unpaid' or r ->> 'to' <> 'paid'
     or r -> 'request' ->> 'id' <> req_id::text or r -> 'request' ->> 'payment_status' <> 'paid'
     or r -> 'request' ->> 'paid_on' <> '2026-10-15' or r -> 'request' ? 'idempotency_key'
     or r -> 'request' -> 'instructor' ->> 'email' <> 'ci-req-b@example.com'
     or jsonb_array_length(r -> 'request' -> 'lessons') <> 2
     or (select array_agg(l ->> 'payment_status') from jsonb_array_elements(r -> 'request' -> 'lessons') l)
        <> array['paid', 'not_required']
     or r -> 'request' -> 'lessons' -> 0 ? 'idempotency_key'
     or not (r -> 'request' -> 'lessons' -> 0 ? 'location')
     or (r -> 'request' -> 'lessons' -> 0 ->> 'request_id') <> req_id::text, true) then
    raise exception 'mark_paid should return the updated request with its lessons: %', r;
  end if;
  if (select array_agg(payment_status || ':' || coalesce(paid_on::text, '-') order by record_no)
        from lesson_insurance_records where request_id = req_id)
     <> array['paid:2026-10-15', 'not_required:-'] then
    raise exception 'mark_paid should cascade to unpaid lessons only';
  end if;
  r := public.lesson_insurance_request_transition(req_id, 'mark_paid', admin_id, '2026-10-15', null, null);
  if r ->> 'outcome' <> 'conflict' or r ->> 'from' <> 'paid' then
    raise exception 'mark_paid twice should conflict: %', r;
  end if;

  r := public.lesson_insurance_request_transition(req_id, 'mark_unpaid', admin_id, null, null, null);
  if r ->> 'outcome' <> 'updated'
     or (select payment_status from lesson_insurance_requests where id = req_id) <> 'unpaid'
     or exists (select 1 from lesson_insurance_records where request_id = req_id
                 and (payment_status = 'paid' or paid_on is not null or paid_note is not null)) then
    raise exception 'mark_unpaid should cascade and clear the payment: %', r;
  end if;
  perform public.lesson_insurance_request_transition(req_id, 'mark_paid', admin_id, '2026-10-16', null, null);

  r := public.lesson_insurance_request_transition(req_id, 'void', admin_id, null, null, 'duplicate');
  if coalesce(r ->> 'from' <> 'paid' or r ->> 'to' <> 'voided' or r -> 'request' ->> 'voided_from_status' <> 'paid'
     or (select array_agg(l ->> 'payment_status') from jsonb_array_elements(r -> 'request' -> 'lessons') l)
        <> array['voided', 'voided'], true) then
    raise exception 'void should return the voided request with its lessons: %', r;
  end if;
  select * into req from lesson_insurance_requests where id = req_id;
  if r ->> 'outcome' <> 'updated' or req.payment_status <> 'voided' or req.voided_from_status <> 'paid'
     or req.voided_reason <> 'duplicate' or req.voided_by <> admin_id or req.paid_on <> '2026-10-16' then
    raise exception 'void should void the request and keep its payment: % %', r, req;
  end if;
  if (select array_agg(payment_status || ':' || voided_from_status order by record_no)
        from lesson_insurance_records where request_id = req_id)
     <> array['voided:paid', 'voided:not_required'] then
    raise exception 'void should cascade to every lesson keeping where each came from';
  end if;
  if pg_temp.owed(b, '2027/28') <> owed_before - 8000 then
    raise exception 'a voided request should leave the total';
  end if;
  r := public.lesson_insurance_request_transition(req_id, 'void', admin_id, null, null, 'again');
  if r ->> 'outcome' <> 'conflict' or r ->> 'from' <> 'voided' then
    raise exception 'voiding twice should conflict: %', r;
  end if;

  free_id := (pg_temp.submit(b, jsonb_build_array(pg_temp.lesson('2027-12-03', 1, 1))) ->> 'id')::uuid;
  update lesson_insurance_records set amount_cents = 0, coverage = 'capped', payment_status = 'not_required'
   where request_id = free_id;
  update lesson_insurance_requests set total_cents = 0, payment_status = 'not_required' where id = free_id;
  r := public.lesson_insurance_request_transition(free_id, 'mark_paid', admin_id, '2026-10-15', null, null);
  if r ->> 'outcome' <> 'conflict' then
    raise exception 'a free request should not be marked paid: %', r;
  end if;
  r := public.lesson_insurance_request_transition(free_id, 'void', admin_id, null, null, 'test');
  if r ->> 'outcome' <> 'updated'
     or (select voided_from_status from lesson_insurance_requests where id = free_id) <> 'not_required' then
    raise exception 'a free request should void: %', r;
  end if;

  r := public.lesson_insurance_request_transition(gen_random_uuid(), 'void', admin_id, null, null, 'x');
  if r ->> 'outcome' <> 'not_found' then
    raise exception 'an unknown request should be not_found: %', r;
  end if;
  begin
    perform public.lesson_insurance_request_transition(req_id, 'refund', admin_id, null, null, null);
    raise exception 'an unknown action was accepted';
  exception when invalid_parameter_value then null;
  end;

  begin
    update lesson_insurance_requests set total_cents = 0
     where id = (select id from lesson_insurance_requests where payment_status = 'unpaid' limit 1);
    raise exception 'an unpaid request with a 0 total was accepted';
  exception when check_violation then null;
  end;
  begin
    update lesson_insurance_requests set payment_status = 'paid'
     where id = (select id from lesson_insurance_requests where payment_status = 'unpaid' limit 1);
    raise exception 'a paid request without paid_on was accepted';
  exception when check_violation then null;
  end;
  begin
    update lesson_insurance_requests set lesson_count = 11 where id = req_id;
    raise exception 'a request of 11 lessons was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into lesson_insurance_records (
      instructor_id, season_key, kind, list_cents, amount_cents, payment_status, record_no, request_id
    ) values (b, '2027/28', 'season_pass', 40000, 0, 'unpaid', 'INS-20990101-0001', req_id);
    raise exception 'a season pass inside a request was accepted';
  exception when check_violation then null;
  end;
end
$$;

do $$
declare
  r text;
  f text;
begin
  if not (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.lesson_insurance_requests'::regclass) then
    raise exception 'lesson_insurance_requests does not have forced row level security';
  end if;
  foreach r in array array['anon', 'authenticated'] loop
    if has_table_privilege(r, 'public.lesson_insurance_requests', 'select, insert, update, delete') then
      raise exception '% has privileges on lesson_insurance_requests', r;
    end if;
  end loop;
  foreach f in array array[
    'public.lesson_insurance_submit_request(uuid, text, jsonb, uuid, uuid)',
    'public.lesson_insurance_request_transition(uuid, text, uuid, date, text, text)',
    'public.lesson_insurance_register(uuid, text, text, date, int, uuid, text, jsonb, boolean, uuid, uuid)',
    'public.lesson_insurance_admin_grant_pass(uuid, text, uuid, uuid, date, text)'
  ] loop
    foreach r in array array['anon', 'authenticated'] loop
      if has_function_privilege(r, f, 'execute') then
        raise exception '% can execute %', r, f;
      end if;
    end loop;
    if not has_function_privilege('service_role', f, 'execute') then
      raise exception 'service_role cannot execute %', f;
    end if;
  end loop;
end
$$;

rollback;

create extension if not exists dblink;

insert into seasons (key, starts_on, ends_on) values ('2027/28', '2027-11-01', '2028-04-30');

create function pg_temp.counter_now() returns int language sql as $$
  select coalesce((select last_no from lesson_insurance_record_counters
                    where day = (now() at time zone 'America/Toronto')::date), 0);
$$;

insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-1111111111b3', 'ci-req-c@example.com');
insert into instructors (id, auth_user_id, email, display_name_en) values
  ('22222222-2222-4222-8222-2222222222b3', '11111111-1111-4111-8111-1111111111b3', 'ci-req-c@example.com', 'CI Request C');

do $$
declare
  c constant uuid := '22222222-2222-4222-8222-2222222222b3';
  conn text := 'dbname=' || current_database()
    || ' user=' || current_user
    || ' port=' || current_setting('port')
    || ' host=' || split_part(current_setting('unix_socket_directories'), ',', 1);
  lessons text := (
    select jsonb_agg(jsonb_build_object(
      'lessonDate', '2026-12-0' || i, 'durationHours', 2,
      'students', '[{"name": "A", "waiverConfirmed": true}, {"name": "B", "waiverConfirmed": true}, {"name": "C", "waiverConfirmed": true}, {"name": "D", "waiverConfirmed": true}]'::jsonb))::text
      from generate_series(1, 3) i);
  call_one text := format('select public.lesson_insurance_submit_request(%L, null, %L::jsonb, gen_random_uuid(), null)::text', c, lessons);
  call_two text := format('select public.lesson_insurance_submit_request(%L, null, %L::jsonb, gen_random_uuid(), null)::text', c, lessons);
  first jsonb;
  second jsonb;
begin
  perform dblink_connect('req_one', conn);
  perform dblink_connect('req_two', conn);
  perform dblink_exec('req_one', 'begin');
  select r::jsonb into first from dblink('req_one', call_one) as t(r text);
  perform dblink_send_query('req_two', call_two);
  perform pg_sleep(0.5);
  if dblink_is_busy('req_two') <> 1 then
    raise exception 'the second request did not wait for the first';
  end if;
  perform dblink_exec('req_one', 'commit');
  select r::jsonb into second from dblink_get_result('req_two') as t(r text);
  perform dblink_disconnect('req_one');
  perform dblink_disconnect('req_two');

  if (select total_cents from lesson_insurance_requests where id = (first ->> 'id')::uuid) <> 24000
     or (select total_cents from lesson_insurance_requests where id = (second ->> 'id')::uuid) <> 16000 then
    raise exception 'two parallel requests should be priced one after the other: % %', first, second;
  end if;
  if (select sum(amount_cents) from lesson_insurance_records where instructor_id = c) <> 40000 then
    raise exception 'two parallel requests exceeded the cap';
  end if;
end
$$;

do $$
declare
  c constant uuid := '22222222-2222-4222-8222-2222222222b3';
  k uuid := gen_random_uuid();
  conn text := 'dbname=' || current_database()
    || ' user=' || current_user
    || ' port=' || current_setting('port')
    || ' host=' || split_part(current_setting('unix_socket_directories'), ',', 1);
  call text := format(
    'select public.lesson_insurance_submit_request(%L, null, ''[{"lessonDate": "2027-01-10", "durationHours": 1, "students": [{"name": "A", "waiverConfirmed": true}]}]''::jsonb, %L, null)::text',
    c, k);
  first jsonb;
  second jsonb;
begin
  perform dblink_connect('idem_one', conn);
  perform dblink_connect('idem_two', conn);
  perform dblink_exec('idem_one', 'begin');
  select r::jsonb into first from dblink('idem_one', call) as t(r text);
  perform dblink_send_query('idem_two', call);
  perform pg_sleep(0.5);
  perform dblink_exec('idem_one', 'commit');
  select r::jsonb into second from dblink_get_result('idem_two') as t(r text);
  perform dblink_disconnect('idem_one');
  perform dblink_disconnect('idem_two');

  if first ->> 'outcome' <> 'created' or second ->> 'outcome' <> 'existing' or first ->> 'id' <> second ->> 'id' then
    raise exception 'two parallel submits with one key should give created then existing: % %', first, second;
  end if;
  if (select count(*) from lesson_insurance_requests where instructor_id = c and idempotency_key = k) <> 1 then
    raise exception 'two parallel submits with one key stored two requests';
  end if;
end
$$;

do $$
declare
  c constant uuid := '22222222-2222-4222-8222-2222222222b3';
  k uuid := gen_random_uuid();
  conn text := 'dbname=' || current_database()
    || ' user=' || current_user
    || ' port=' || current_setting('port')
    || ' host=' || split_part(current_setting('unix_socket_directories'), ',', 1);
  lesson text := '[{"lessonDate": "%s", "durationHours": 1, "students": [{"name": "A", "waiverConfirmed": true}]}]';
  call_one text := format('select public.lesson_insurance_submit_request(%L, null, %L::jsonb, %L, null)::text',
    c, format(lesson, '2027-01-11'), k);
  call_two text := format('select public.lesson_insurance_submit_request(%L, null, %L::jsonb, %L, null)::text',
    c, format(lesson, '2027-12-11'), k);
  first jsonb;
  second jsonb;
  requests_before int := (select count(*) from lesson_insurance_requests where instructor_id = c);
  records_before int := (select count(*) from lesson_insurance_records where instructor_id = c);
  counter_before int;
begin
  perform dblink_connect('key_one', conn);
  perform dblink_connect('key_two', conn);
  perform dblink_exec('key_one', 'begin');
  select r::jsonb into first from dblink('key_one', call_one) as t(r text);
  counter_before := (select last_no from dblink('key_one',
    'select last_no from lesson_insurance_record_counters where day = (now() at time zone ''America/Toronto'')::date')
    as t(last_no int));
  perform dblink_send_query('key_two', call_two);
  perform pg_sleep(0.5);
  if dblink_is_busy('key_two') <> 1 then
    raise exception 'a same-key submit in another season did not wait for the first';
  end if;
  perform dblink_exec('key_one', 'commit');
  select r::jsonb into second from dblink_get_result('key_two') as t(r text);
  perform dblink_disconnect('key_one');
  perform dblink_disconnect('key_two');

  if coalesce(first ->> 'outcome' <> 'created' or second ->> 'outcome' <> 'existing' or first ->> 'id' <> second ->> 'id', true) then
    raise exception 'same-key submits in two seasons should give created then the original: % %', first, second;
  end if;
  if coalesce((select count(*) from lesson_insurance_requests where instructor_id = c) <> requests_before + 1
     or (select count(*) from lesson_insurance_records where instructor_id = c) <> records_before + 1
     or (select season_key from lesson_insurance_requests where id = (first ->> 'id')::uuid) <> '2026/27', true) then
    raise exception 'same-key submits in two seasons left extra rows behind';
  end if;
  if coalesce(pg_temp.counter_now() <> counter_before, true) then
    raise exception 'the repeated same-key submit used a number';
  end if;
end
$$;

do $$
declare
  c constant uuid := '22222222-2222-4222-8222-2222222222b3';
  admin_id constant uuid := '11111111-1111-4111-8111-1111111111b3';
  req_id uuid;
  conn text := 'dbname=' || current_database()
    || ' user=' || current_user
    || ' port=' || current_setting('port')
    || ' host=' || split_part(current_setting('unix_socket_directories'), ',', 1);
  first jsonb;
  second jsonb;
begin
  perform dblink_connect('move_one', conn);
  perform dblink_connect('move_two', conn);
  select (r::jsonb ->> 'id')::uuid into req_id from dblink('move_one', format(
    'select public.lesson_insurance_submit_request(%L, null, %L::jsonb, gen_random_uuid(), null)::text', c,
    '[{"lessonDate": "2027-12-12", "durationHours": 1, "students": [{"name": "A", "waiverConfirmed": true}]},
      {"lessonDate": "2027-12-13", "durationHours": 2, "students": [{"name": "A", "waiverConfirmed": true}]}]'))
    as t(r text);
  perform dblink_exec('move_one', 'begin');
  select r::jsonb into first from dblink('move_one', format(
    'select public.lesson_insurance_request_transition(%L, ''mark_paid'', %L, ''2026-10-15'', null, null)::text',
    req_id, admin_id)) as t(r text);
  perform dblink_send_query('move_two', format(
    'select public.lesson_insurance_request_transition(%L, ''mark_unpaid'', %L, null, null, null)::text',
    req_id, admin_id));
  perform pg_sleep(0.5);
  if dblink_is_busy('move_two') <> 1 then
    raise exception 'a second transition did not wait for the first';
  end if;
  perform dblink_exec('move_one', 'commit');
  select r::jsonb into second from dblink_get_result('move_two') as t(r text);
  perform dblink_disconnect('move_one');
  perform dblink_disconnect('move_two');

  if coalesce(first ->> 'from' <> 'unpaid' or first ->> 'to' <> 'paid'
     or first -> 'request' ->> 'payment_status' <> 'paid'
     or first -> 'request' ->> 'paid_on' <> '2026-10-15'
     or (select bool_and(l ->> 'payment_status' = 'paid') from jsonb_array_elements(first -> 'request' -> 'lessons') l)
        is not true, true) then
    raise exception 'the first transition should answer with its own result: %', first;
  end if;
  if coalesce(second ->> 'from' <> 'paid' or second ->> 'to' <> 'unpaid'
     or second -> 'request' ->> 'payment_status' <> 'unpaid'
     or (select bool_and(l ->> 'payment_status' = 'unpaid') from jsonb_array_elements(second -> 'request' -> 'lessons') l)
        is not true, true) then
    raise exception 'the second transition should start from the first result: %', second;
  end if;
  if (select payment_status from lesson_insurance_requests where id = req_id) <> 'unpaid' then
    raise exception 'the request should end unpaid';
  end if;
end
$$;

delete from lesson_insurance_records where instructor_id = '22222222-2222-4222-8222-2222222222b3';
delete from lesson_insurance_requests where instructor_id = '22222222-2222-4222-8222-2222222222b3';
delete from instructors where id = '22222222-2222-4222-8222-2222222222b3';
delete from auth.users where id = '11111111-1111-4111-8111-1111111111b3';
delete from seasons where key = '2027/28';

\echo 'Lesson insurance request checks passed.'
