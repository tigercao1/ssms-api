\set ON_ERROR_STOP on
begin;

insert into auth.users (id, email)
values ('11111111-1111-4111-8111-111111111111', 'ci-booking@example.com'),
       ('11111111-1111-4111-8111-111111111112', 'ci-booking-2@example.com');
insert into instructors (id, auth_user_id, email, display_name_en)
values ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'ci-booking@example.com', 'CI Booking'),
       ('22222222-2222-4222-8222-222222222223', '11111111-1111-4111-8111-111111111112', 'ci-booking-2@example.com', 'CI Booking Two');
insert into customers (id, shopify_customer_id, first_name, last_name, phone)
values ('33333333-3333-4333-8333-333333333333', 1001, 'Mei', 'Wang', '+1 (647) 555-0100');
insert into lesson_types (id, name_en, name_zh, group_size, duration_min)
values ('44444444-4444-4444-8444-444444444444', 'Private 2h', '1对1滑雪课 - 2小时', 1, 120);

do $$
begin
  if (select search_text from customers where shopify_customer_id = 1001)
     not like '%wangmei%16475550100%' then
    raise exception 'customer search_text is missing the joined name or phone digits';
  end if;
  begin
    insert into customers (shopify_customer_id) values (1001);
    raise exception 'a duplicate shopify_customer_id was accepted';
  exception when unique_violation then null;
  end;
  begin
    insert into lesson_types (name_en, duration_min) values (' private 2H ', 60);
    raise exception 'a duplicate lesson type name was accepted';
  exception when unique_violation then null;
  end;
end
$$;

do $$
declare
  lt constant uuid := '44444444-4444-4444-8444-444444444444';
  i1 constant uuid := '22222222-2222-4222-8222-222222222222';
  i2 constant uuid := '22222222-2222-4222-8222-222222222223';
begin
  insert into pay_rates (lesson_type_id, hourly_rate, effective_from, effective_to)
  values (lt, 40, '2026-11-01', '2026-12-31');
  insert into pay_rates (lesson_type_id, hourly_rate, effective_from)
  values (lt, 45, '2027-01-01');
  begin
    insert into pay_rates (lesson_type_id, hourly_rate, effective_from, effective_to)
    values (lt, 50, '2026-12-31', '2027-01-15');
    raise exception 'an overlapping default pay rate was accepted';
  exception when exclusion_violation then null;
  end;
  begin
    insert into pay_rates (lesson_type_id, hourly_rate, effective_from)
    values (lt, 50, '2030-01-01');
    raise exception 'a default pay rate overlapping an open-ended one was accepted';
  exception when exclusion_violation then null;
  end;
  insert into pay_rates (lesson_type_id, instructor_id, hourly_rate, effective_from)
  values (lt, i1, 55, '2026-11-15');
  insert into pay_rates (lesson_type_id, instructor_id, hourly_rate, effective_from)
  values (lt, i2, 60, '2026-11-15');
  begin
    insert into pay_rates (lesson_type_id, instructor_id, hourly_rate, effective_from, effective_to)
    values (lt, i1, 65, '2026-10-01', '2026-11-15');
    raise exception 'an overlapping instructor pay rate was accepted';
  exception when exclusion_violation then null;
  end;
  insert into pay_rates (lesson_type_id, instructor_id, hourly_rate, effective_from, effective_to)
  values (lt, i1, 65, '2026-10-01', '2026-11-14');
  begin
    update pay_rates set effective_to = '2026-12-01'
     where instructor_id = i1 and effective_from = '2026-10-01';
    raise exception 'extending a pay rate into the next one was accepted';
  exception when exclusion_violation then null;
  end;
  begin
    insert into pay_rates (lesson_type_id, hourly_rate, effective_from, effective_to)
    values (lt, 40, '2025-02-01', '2025-01-31');
    raise exception 'a pay rate ending before it starts was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into pay_rates (lesson_type_id, hourly_rate, effective_from)
    values (lt, -1, '2020-01-01');
    raise exception 'a negative pay rate was accepted';
  exception when check_violation then null;
  end;
end
$$;

do $$
begin
  begin
    insert into classes (instructor_id, starts_at, ends_at)
    values ('22222222-2222-4222-8222-222222222222', '2026-12-12 10:00-05', '2026-12-12 10:00-05');
    raise exception 'a class ending when it starts was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into classes (instructor_id, starts_at, ends_at)
    values ('22222222-2222-4222-8222-222222222222', '2026-12-12 10:00-05', '2026-12-12 09:00-05');
    raise exception 'a class ending before it starts was accepted';
  exception when check_violation then null;
  end;
  insert into classes (id, instructor_id, lesson_type_id, starts_at, ends_at)
  values ('55555555-5555-4555-8555-555555555555', '22222222-2222-4222-8222-222222222222',
          '44444444-4444-4444-8444-444444444444', '2026-12-12 10:00-05', '2026-12-12 12:00-05');
  insert into class_participants (class_id, customer_id)
  values ('55555555-5555-4555-8555-555555555555', '33333333-3333-4333-8333-333333333333');
  insert into instructor_calendars (instructor_id, google_calendar_id)
  values ('22222222-2222-4222-8222-222222222222', 'ci-booking@example.com');
  begin
    insert into instructor_calendars (instructor_id, google_calendar_id)
    values ('22222222-2222-4222-8222-222222222223', 'ci-booking@example.com');
    raise exception 'one calendar was linked to two instructors';
  exception when unique_violation then null;
  end;
end
$$;

do $$
declare
  t text;
  r text;
begin
  foreach t in array array['instructor_calendars', 'customers', 'lesson_types', 'pay_rates', 'classes', 'class_participants'] loop
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
end
$$;

set local role anon;
do $$
begin
  perform 1 from customers;
  raise exception 'anon could read customers';
exception when insufficient_privilege then null;
end
$$;
do $$
begin
  perform 1 from pay_rates;
  raise exception 'anon could read pay_rates';
exception when insufficient_privilege then null;
end
$$;
reset role;

rollback;
\echo 'Booking foundation checks passed.'
