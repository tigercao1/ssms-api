\set ON_ERROR_STOP on
begin;

insert into auth.users (id, email)
values ('11111111-1111-4111-8111-111111111191', 'ci-ics@example.com');
insert into instructors (id, auth_user_id, email, display_name_en)
values ('22222222-2222-4222-8222-222222222291', '11111111-1111-4111-8111-111111111191', 'ci-ics@example.com', 'CI Ics');
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

rollback;
\echo 'Class ICS sequence checks passed.'
