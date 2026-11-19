\set ON_ERROR_STOP on
begin;

insert into auth.users (id, email)
values ('11111111-1111-4111-8111-111111111191', 'ci-ics@example.com');
insert into instructors (id, auth_user_id, email, display_name_en)
values ('22222222-2222-4222-8222-222222222291', '11111111-1111-4111-8111-111111111191', 'ci-ics@example.com', 'CI Ics');
insert into customers (id, shopify_customer_id, first_name)
values ('33333333-3333-4333-8333-333333333391', 9101, 'Ann'),
       ('33333333-3333-4333-8333-333333333392', 9102, 'Bo');
insert into lesson_types (id, name_en, duration_min)
values ('44444444-4444-4444-8444-444444444491', 'CI Ics 1h', 60);
insert into classes (id, instructor_id, starts_at, ends_at, status, source)
values ('55555555-5555-4555-8555-555555555591', '22222222-2222-4222-8222-222222222291',
        '2030-01-05T15:00:00Z', '2030-01-05T16:00:00Z', 'scheduled', 'ssms');

do $$
declare
  v_seq int;
begin
  select ics_sequence into v_seq from classes where id = '55555555-5555-4555-8555-555555555591';
  if v_seq <> 0 then
    raise exception 'a new class must start at ics_sequence 0, got %', v_seq;
  end if;

  update classes set notes = 'bring helmet', google_sync_status = 'failed'
   where id = '55555555-5555-4555-8555-555555555591';
  select ics_sequence into v_seq from classes where id = '55555555-5555-4555-8555-555555555591';
  if v_seq <> 0 then
    raise exception 'notes and sync bookkeeping must not bump ics_sequence, got %', v_seq;
  end if;

  update classes set starts_at = '2030-01-05T17:00:00Z', ends_at = '2030-01-05T18:00:00Z'
   where id = '55555555-5555-4555-8555-555555555591';
  select ics_sequence into v_seq from classes where id = '55555555-5555-4555-8555-555555555591';
  if v_seq <> 1 then
    raise exception 'a new time must bump ics_sequence to 1, got %', v_seq;
  end if;

  perform set_class_status('55555555-5555-4555-8555-555555555591', 'cancelled');
  select ics_sequence into v_seq from classes where id = '55555555-5555-4555-8555-555555555591';
  if v_seq <> 2 then
    raise exception 'cancelling must bump ics_sequence to 2, got %', v_seq;
  end if;
end
$$;

do $$
declare
  c constant uuid := '55555555-5555-4555-8555-555555555592';
  ann constant uuid := '33333333-3333-4333-8333-333333333391';
  bo constant uuid := '33333333-3333-4333-8333-333333333392';
  v_class constant jsonb := jsonb_build_object(
    'instructor_id', '22222222-2222-4222-8222-222222222291',
    'lesson_type_id', '44444444-4444-4444-8444-444444444491',
    'starts_at', '2030-01-06T15:00:00Z', 'ends_at', '2030-01-06T16:00:00Z');
  v_seq int;
begin
  perform book_classes(null, jsonb_build_array(
    v_class || jsonb_build_object('id', c, 'customer_ids', jsonb_build_array(ann, bo))));
  select ics_sequence into v_seq from classes where id = c;
  if v_seq <> 0 then
    raise exception 'booking with customers must leave ics_sequence at 0, got %', v_seq;
  end if;

  update classes set created_at = created_at - interval '1 day' where id = c;

  perform rebook_class(c, v_class, jsonb_build_array(ann, bo));
  select ics_sequence into v_seq from classes where id = c;
  if v_seq <> 0 then
    raise exception 'an unchanged customer list must not bump ics_sequence, got %', v_seq;
  end if;

  perform rebook_class(c, v_class, jsonb_build_array(ann));
  select ics_sequence into v_seq from classes where id = c;
  if v_seq <> 1 then
    raise exception 'removing a customer must bump ics_sequence to 1, got %', v_seq;
  end if;

  perform rebook_class(c, v_class, jsonb_build_array(ann, bo));
  select ics_sequence into v_seq from classes where id = c;
  if v_seq <> 2 then
    raise exception 're-adding a customer must bump ics_sequence to 2, got %', v_seq;
  end if;
end
$$;

rollback;
\echo 'Class ICS sequence checks passed.'
