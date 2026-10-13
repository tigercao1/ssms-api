\set ON_ERROR_STOP on
begin;

insert into auth.users (id, email)
values ('11111111-1111-4111-8111-111111111121', 'ci-book@example.com');
insert into instructors (id, auth_user_id, email, display_name_en)
values ('22222222-2222-4222-8222-222222222231', '11111111-1111-4111-8111-111111111121', 'ci-book@example.com', 'CI Book');
insert into customers (id, shopify_customer_id, first_name)
values ('33333333-3333-4333-8333-333333333341', 2001, 'Ann'),
       ('33333333-3333-4333-8333-333333333342', 2002, 'Bo');
insert into lesson_types (id, name_en, duration_min)
values ('44444444-4444-4444-8444-444444444451', 'CI Private 1h', 60);

do $$
begin
  if (select count(*) from booking_settings) <> 1 then
    raise exception 'booking_settings must hold exactly one row';
  end if;
  if (select day_start_time::text || '-' || day_end_time::text || '/' || slot_minutes from booking_settings)
     <> '08:00:00-18:00:00/30' then
    raise exception 'booking_settings defaults are wrong';
  end if;
  begin
    update booking_settings set slot_minutes = 20;
    raise exception 'a 20 minute slot was accepted';
  exception when check_violation then null;
  end;
  begin
    update booking_settings set day_end_time = '07:00';
    raise exception 'a day ending before it starts was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into booking_settings (id) values (false);
    raise exception 'a second settings row was accepted';
  exception when check_violation then null;
  end;
end
$$;

do $$
declare
  i constant uuid := '22222222-2222-4222-8222-222222222231';
  lt constant uuid := '44444444-4444-4444-8444-444444444451';
begin
  perform book_classes(
    jsonb_build_object('id', '66666666-6666-4666-8666-666666666661', 'count', 2),
    jsonb_build_array(
      jsonb_build_object('id', '55555555-5555-4555-8555-555555555561', 'instructor_id', i,
        'lesson_type_id', lt, 'starts_at', '2026-12-12 10:00-05', 'ends_at', '2026-12-12 11:00-05',
        'google_calendar_id', 'cal', 'google_event_id', 'ev1',
        'customer_ids', jsonb_build_array('33333333-3333-4333-8333-333333333341')),
      jsonb_build_object('id', '55555555-5555-4555-8555-555555555562', 'instructor_id', i,
        'lesson_type_id', lt, 'starts_at', '2026-12-19 10:00-05', 'ends_at', '2026-12-19 11:00-05',
        'customer_ids', jsonb_build_array('33333333-3333-4333-8333-333333333341'))
    )
  );
  if (select count(*) from classes where series_id = '66666666-6666-4666-8666-666666666661' and status = 'scheduled') <> 2 then
    raise exception 'book_classes did not create the scheduled series';
  end if;
  if (select count(*) from class_participants where customer_id = '33333333-3333-4333-8333-333333333341') <> 2 then
    raise exception 'book_classes did not add participants';
  end if;
  if (select google_sync_status || '/' || google_calendar_id || '/' || coalesce(google_event_id, '-')
        from classes where id = '55555555-5555-4555-8555-555555555561') <> 'pending/cal/-' then
    raise exception 'book_classes did not leave the calendar class pending without an event';
  end if;
  if (select google_sync_status || '/' || coalesce(google_calendar_id, '-')
        from classes where id = '55555555-5555-4555-8555-555555555562') <> 'ok/-' then
    raise exception 'book_classes marked a class without a calendar for sync';
  end if;

  perform book_classes(null, jsonb_build_array(
    jsonb_build_object('id', '55555555-5555-4555-8555-555555555563', 'instructor_id', i,
      'lesson_type_id', lt, 'starts_at', '2025-12-20 10:00-05', 'ends_at', '2025-12-20 11:00-05',
      'status', 'completed')));
  if (select status from classes where id = '55555555-5555-4555-8555-555555555563') <> 'completed' then
    raise exception 'book_classes ignored the requested status';
  end if;

  begin
    perform book_classes(
      jsonb_build_object('id', '66666666-6666-4666-8666-666666666662', 'count', 2),
      jsonb_build_array(
        jsonb_build_object('id', '55555555-5555-4555-8555-555555555564', 'instructor_id', i,
          'lesson_type_id', lt, 'starts_at', '2026-12-26 10:00-05', 'ends_at', '2026-12-26 11:00-05'),
        jsonb_build_object('id', '55555555-5555-4555-8555-555555555565', 'instructor_id', i,
          'lesson_type_id', lt, 'starts_at', '2026-12-12 10:30-05', 'ends_at', '2026-12-12 11:30-05')
      )
    );
    raise exception 'an overlapping series was accepted';
  exception when sqlstate 'SB409' then null;
  end;
  if exists (select 1 from classes where id = '55555555-5555-4555-8555-555555555564')
     or exists (select 1 from class_series where id = '66666666-6666-4666-8666-666666666662') then
    raise exception 'a rejected series left rows behind';
  end if;

  perform book_classes(null, jsonb_build_array(
    jsonb_build_object('id', '55555555-5555-4555-8555-555555555566', 'instructor_id', i,
      'lesson_type_id', lt, 'starts_at', '2026-12-12 11:00-05', 'ends_at', '2026-12-12 12:00-05')));
end
$$;

do $$
declare
  i constant uuid := '22222222-2222-4222-8222-222222222231';
  lt constant uuid := '44444444-4444-4444-8444-444444444451';
begin
  begin
    perform rebook_class('55555555-5555-4555-8555-555555555566',
      jsonb_build_object('instructor_id', i, 'lesson_type_id', lt,
        'starts_at', '2026-12-12 10:30-05', 'ends_at', '2026-12-12 11:30-05'), null);
    raise exception 'moving onto another class was accepted';
  exception when sqlstate 'SB409' then null;
  end;

  perform rebook_class('55555555-5555-4555-8555-555555555561',
    jsonb_build_object('instructor_id', i, 'lesson_type_id', lt,
      'starts_at', '2026-12-12 09:30-05', 'ends_at', '2026-12-12 10:30-05',
      'google_calendar_id', 'cal', 'google_event_id', 'ev1', 'notes', 'moved'),
    jsonb_build_array('33333333-3333-4333-8333-333333333342'));
  if (select starts_at from classes where id = '55555555-5555-4555-8555-555555555561')
     <> '2026-12-12 09:30-05'::timestamptz then
    raise exception 'rebook_class did not move the class';
  end if;
  if (select array_agg(customer_id::text) from class_participants where class_id = '55555555-5555-4555-8555-555555555561')
     <> array['33333333-3333-4333-8333-333333333342'] then
    raise exception 'rebook_class did not replace participants';
  end if;

  if (select google_sync_status from classes where id = '55555555-5555-4555-8555-555555555561') <> 'pending' then
    raise exception 'rebook_class did not mark the calendar class pending';
  end if;
end
$$;

do $$
declare
  c constant uuid := '55555555-5555-4555-8555-555555555561';
  i constant uuid := '22222222-2222-4222-8222-222222222231';
  lt constant uuid := '44444444-4444-4444-8444-444444444451';
  v timestamptz;
  r text;
begin
  if class_google_event_id('c0000000-0000-4000-8000-000000000001', 2)
     <> 'ssmsc00000000000400080000000000000012' then
    raise exception 'class_google_event_id has the wrong shape';
  end if;

  select updated_at into v from classes where id = c;
  r := finish_class_google_sync(c, v - interval '1 second', 'cal', 'ev1', null);
  if r <> 'stale' or (select google_sync_status from classes where id = c) <> 'pending' then
    raise exception 'a stale sync result changed the sync status';
  end if;
  if (select google_event_id from classes where id = c) <> 'ev1' then
    raise exception 'a stale sync result did not keep the created event id';
  end if;

  select updated_at into v from classes where id = c;
  r := finish_class_google_sync(c, v, 'cal', 'ev1', '503:backendError');
  if r <> 'failed'
     or (select google_sync_status || '/' || google_sync_attempts || '/' || google_sync_error from classes where id = c)
        <> 'failed/1/503:backendError' then
    raise exception 'a failed sync was not recorded';
  end if;

  select updated_at into v from classes where id = c;
  r := finish_class_google_sync(c, v, 'cal', 'ev1', null);
  if r <> 'ok'
     or (select google_sync_status || '/' || google_sync_attempts || '/' || coalesce(google_sync_error, '-') from classes where id = c)
        <> 'ok/0/-'
     or (select google_synced_at from classes where id = c) is null then
    raise exception 'a successful sync was not recorded';
  end if;

  perform rebook_class(c,
    jsonb_build_object('instructor_id', i, 'lesson_type_id', lt,
      'starts_at', '2026-12-12 09:30-05', 'ends_at', '2026-12-12 10:30-05',
      'google_calendar_id', 'cal2', 'notes', 'moved'), null);
  if not exists (select 1 from google_event_deletions
                  where google_calendar_id = 'cal' and google_event_id = 'ev1' and class_id = c) then
    raise exception 'moving to another calendar did not queue the old event';
  end if;
  if (select google_sync_status || '/' || google_calendar_id || '/' || coalesce(google_event_id, '-') || '/' || google_event_seq
        from classes where id = c) <> 'pending/cal2/-/1' then
    raise exception 'moving to another calendar did not reset the event';
  end if;

  select updated_at into v from classes where id = c;
  r := finish_class_google_sync(c, v, 'cal', 'late', null);
  if not exists (select 1 from google_event_deletions where google_calendar_id = 'cal' and google_event_id = 'late')
     or (select google_event_id from classes where id = c) is not null then
    raise exception 'an event created on the old calendar was not queued for deletion';
  end if;

  perform set_class_status(c, 'cancelled');
  if (select status || '/' || coalesce(google_event_id, '-') || '/' || google_sync_status || '/' || google_event_seq
        from classes where id = c) <> 'cancelled/-/pending/2' then
    raise exception 'cancelling did not clear the Google event and mark the class pending';
  end if;
  if not exists (select 1 from google_event_deletions
                  where google_calendar_id = 'cal2' and google_event_id = class_google_event_id(c, 1)) then
    raise exception 'cancelling did not queue the possibly created event';
  end if;

  select updated_at into v from classes where id = c;
  r := finish_class_google_sync(c, v, 'cal2', 'oncancelled', null);
  if not exists (select 1 from google_event_deletions where google_event_id = 'oncancelled' and class_id = c)
     or (select google_sync_status from classes where id = c) <> 'ok' then
    raise exception 'an event created for a cancelled class was not queued for deletion';
  end if;

  r := finish_class_google_sync('55555555-5555-4555-8555-555555555598', now(), 'cal', 'orphan', null);
  if r <> 'missing'
     or not exists (select 1 from google_event_deletions where google_event_id = 'orphan' and class_id is null) then
    raise exception 'an event for a missing class was not queued for deletion';
  end if;

  perform book_classes(null, jsonb_build_array(
    jsonb_build_object('id', '55555555-5555-4555-8555-555555555568', 'instructor_id', i,
      'lesson_type_id', lt, 'starts_at', '2026-12-14 09:00-05', 'ends_at', '2026-12-14 10:00-05',
      'google_calendar_id', 'cal3')));
  perform set_class_status('55555555-5555-4555-8555-555555555568', 'cancelled');
  perform set_class_status('55555555-5555-4555-8555-555555555568', 'scheduled');
  if (select status || '/' || google_sync_status || '/' || google_calendar_id || '/' || google_event_seq
        from classes where id = '55555555-5555-4555-8555-555555555568') <> 'scheduled/pending/cal3/1' then
    raise exception 'restoring a calendar class did not mark it pending for a new event';
  end if;
end
$$;

do $$
declare
  i constant uuid := '22222222-2222-4222-8222-222222222231';
  lt constant uuid := '44444444-4444-4444-8444-444444444451';
begin

  begin
    perform rebook_class('55555555-5555-4555-8555-555555555561',
      jsonb_build_object('instructor_id', i, 'lesson_type_id', lt,
        'starts_at', '2026-12-13 09:30-05', 'ends_at', '2026-12-13 10:30-05'), null);
    raise exception 'a cancelled class was moved';
  exception when sqlstate 'P0002' then null;
  end;

  perform book_classes(null, jsonb_build_array(
    jsonb_build_object('id', '55555555-5555-4555-8555-555555555567', 'instructor_id', i,
      'lesson_type_id', lt, 'starts_at', '2026-12-12 09:00-05', 'ends_at', '2026-12-12 10:00-05')));
  begin
    perform set_class_status('55555555-5555-4555-8555-555555555561', 'completed');
    raise exception 'restoring a cancelled class onto another class was accepted';
  exception when sqlstate 'SB409' then null;
  end;

  perform set_class_status('55555555-5555-4555-8555-555555555566', 'no_show');
  if (select status from classes where id = '55555555-5555-4555-8555-555555555566') <> 'no_show' then
    raise exception 'set_class_status did not mark the no-show';
  end if;

  begin
    perform set_class_status('55555555-5555-4555-8555-555555555599', 'completed');
    raise exception 'an unknown class status change was accepted';
  exception when sqlstate 'P0002' then null;
  end;
end
$$;

do $$
declare
  t text;
  f text;
  r text;
begin
  foreach t in array array['class_series', 'booking_settings', 'google_event_deletions'] loop
    if not exists (
      select 1 from pg_class
       where oid = ('public.' || t)::regclass and relrowsecurity and relforcerowsecurity
    ) then
      raise exception '% does not have forced row level security', t;
    end if;
    foreach r in array array['anon', 'authenticated'] loop
      if has_table_privilege(r, 'public.' || t, 'select, insert, update, delete') then
        raise exception '% has privileges on %', r, t;
      end if;
    end loop;
  end loop;
  foreach f in array array['book_classes(jsonb, jsonb)', 'rebook_class(uuid, jsonb, jsonb)', 'set_class_status(uuid, text)',
                           'class_google_event_id(uuid, int)', 'finish_class_google_sync(uuid, timestamptz, text, text, text)'] loop
    foreach r in array array['anon', 'authenticated'] loop
      if has_function_privilege(r, 'public.' || f, 'execute') then
        raise exception '% can execute %', r, f;
      end if;
    end loop;
    if not has_function_privilege('service_role', 'public.' || f, 'execute') then
      raise exception 'service_role cannot execute %', f;
    end if;
  end loop;
end
$$;

rollback;
\echo 'Booking checks passed.'
