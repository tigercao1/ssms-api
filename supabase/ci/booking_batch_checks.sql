\set ON_ERROR_STOP on
begin;

insert into auth.users (id, email)
values ('11111111-1111-4111-8111-111111111151', 'ci-batch@example.com');
insert into instructors (id, auth_user_id, email, display_name_en)
values ('22222222-2222-4222-8222-222222222251', '11111111-1111-4111-8111-111111111151', 'ci-batch@example.com', 'CI Batch');
insert into customers (id, shopify_customer_id, first_name)
values ('33333333-3333-4333-8333-333333333351', 2051, 'Ann');
insert into lesson_types (id, name_en, duration_min)
values ('44444444-4444-4444-8444-444444444461', 'CI Batch 1h', 60);

do $$
declare
  b constant uuid := '77777777-7777-4777-8777-777777777771';
  i constant uuid := '22222222-2222-4222-8222-222222222251';
  lt constant uuid := '44444444-4444-4444-8444-444444444461';
  h constant text := repeat('a', 64);
  v_result jsonb;
begin
  v_result := book_batch_row(b, 0, h,
    jsonb_build_object('id', '55555555-5555-4555-8555-555555555571', 'instructor_id', i,
      'lesson_type_id', lt, 'starts_at', '2026-12-12 10:00-05', 'ends_at', '2026-12-12 11:00-05',
      'created_by', '11111111-1111-4111-8111-111111111151',
      'customer_ids', jsonb_build_array('33333333-3333-4333-8333-333333333351')));
  if v_result <> jsonb_build_object('outcome', 'created', 'row_index', 0, 'payload_hash', h,
                                    'class_id', '55555555-5555-4555-8555-555555555571') then
    raise exception 'book_batch_row returned %', v_result;
  end if;
  if (select count(*) from class_participants where class_id = '55555555-5555-4555-8555-555555555571') <> 1 then
    raise exception 'book_batch_row did not book the class';
  end if;
  if (select created_by from booking_batch_rows where batch_id = b and row_index = 0)
     <> '11111111-1111-4111-8111-111111111151' then
    raise exception 'book_batch_row did not record who booked the row';
  end if;

  v_result := book_batch_row(b, 0, repeat('b', 64),
    jsonb_build_object('id', '55555555-5555-4555-8555-555555555572', 'instructor_id', i,
      'lesson_type_id', lt, 'starts_at', '2026-12-13 10:00-05', 'ends_at', '2026-12-13 11:00-05'));
  if v_result <> jsonb_build_object('outcome', 'existing', 'row_index', 0, 'payload_hash', h,
                                    'class_id', '55555555-5555-4555-8555-555555555571') then
    raise exception 'a replayed row returned %', v_result;
  end if;
  if exists (select 1 from classes where id = '55555555-5555-4555-8555-555555555572') then
    raise exception 'a replayed row booked a second class';
  end if;

  begin
    perform book_batch_row(b, 1, h,
      jsonb_build_object('id', '55555555-5555-4555-8555-555555555573', 'instructor_id', i,
        'lesson_type_id', lt, 'starts_at', '2026-12-12 10:30-05', 'ends_at', '2026-12-12 11:30-05'));
    raise exception 'an overlapping batch row was accepted';
  exception when sqlstate 'SB409' then null;
  end;
  if exists (select 1 from booking_batch_rows where batch_id = b and row_index = 1)
     or exists (select 1 from classes where id = '55555555-5555-4555-8555-555555555573') then
    raise exception 'a rejected batch row left rows behind';
  end if;

  v_result := book_batch_row(b, 1, h,
    jsonb_build_object('id', '55555555-5555-4555-8555-555555555574', 'instructor_id', i,
      'lesson_type_id', lt, 'starts_at', '2026-12-12 11:00-05', 'ends_at', '2026-12-12 12:00-05'));
  if v_result->>'outcome' <> 'created' then
    raise exception 'a failed batch row could not be retried: %', v_result;
  end if;

  begin
    perform book_batch_row(b, 2, 'not-a-hash',
      jsonb_build_object('id', '55555555-5555-4555-8555-555555555575', 'instructor_id', i,
        'lesson_type_id', lt, 'starts_at', '2026-12-14 10:00-05', 'ends_at', '2026-12-14 11:00-05'));
    raise exception 'a malformed payload hash was accepted';
  exception when check_violation then null;
  end;
  if exists (select 1 from classes where id = '55555555-5555-4555-8555-555555555575') then
    raise exception 'a rejected payload hash left a class behind';
  end if;

  begin
    insert into booking_batch_rows (batch_id, row_index, payload_hash, class_id)
    values (b, 0, h, '55555555-5555-4555-8555-555555555574');
    raise exception 'a second row with the same batch index was accepted';
  exception when unique_violation then null;
  end;
  begin
    insert into booking_batch_rows (batch_id, row_index, payload_hash, class_id)
    values ('77777777-7777-4777-8777-777777777772', -1, h, '55555555-5555-4555-8555-555555555574');
    raise exception 'a negative row index was accepted';
  exception when check_violation then null;
  end;
end
$$;

do $$
declare
  r text;
begin
  if not exists (
    select 1 from pg_class
     where relname = 'booking_batch_rows' and relrowsecurity and relforcerowsecurity
  ) then
    raise exception 'booking_batch_rows does not have forced row level security';
  end if;
  foreach r in array array['anon', 'authenticated'] loop
    if has_table_privilege(r, 'public.booking_batch_rows', 'select, insert, update, delete') then
      raise exception '% has privileges on booking_batch_rows', r;
    end if;
    if has_function_privilege(r, 'public.book_batch_row(uuid, int, text, jsonb)', 'execute') then
      raise exception '% can execute book_batch_row', r;
    end if;
  end loop;
  if not has_function_privilege('service_role', 'public.book_batch_row(uuid, int, text, jsonb)', 'execute') then
    raise exception 'service_role cannot execute book_batch_row';
  end if;
end
$$;

rollback;
\echo 'Booking batch checks passed.'
