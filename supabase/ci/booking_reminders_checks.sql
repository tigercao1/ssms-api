\set ON_ERROR_STOP on
begin;

insert into auth.users (id, email)
values ('11111111-1111-4111-8111-111111111181', 'ci-reminders@example.com');
insert into instructors (id, auth_user_id, email, display_name_en)
values ('22222222-2222-4222-8222-222222222281', '11111111-1111-4111-8111-111111111181', 'ci-reminders@example.com', 'CI Reminders');
insert into customers (id, shopify_customer_id, first_name)
values ('33333333-3333-4333-8333-333333333381', 8101, 'Ann');
insert into lesson_types (id, name_en, duration_min)
values ('44444444-4444-4444-8444-444444444481', 'CI Reminders 1h', 60);

do $$
begin
  if (select enabled::text || ':' || offsets_minutes::text from booking_reminder_settings)
     <> 'true:{1440,60}' then
    raise exception 'booking_reminder_settings defaults are wrong';
  end if;
  update booking_reminder_settings set enabled = false, offsets_minutes = '{20160,2880,180,60,15}';
  update booking_reminder_settings set offsets_minutes = '{}';
  begin
    update booking_reminder_settings set offsets_minutes = '{20160,2880,180,60,30,15}';
    raise exception 'six reminder times were accepted';
  exception when check_violation then null;
  end;
  begin
    update booking_reminder_settings set offsets_minutes = '{14}';
    raise exception 'a 14 minute reminder was accepted';
  exception when check_violation then null;
  end;
  begin
    update booking_reminder_settings set offsets_minutes = '{20161}';
    raise exception 'a reminder over 14 days was accepted';
  exception when check_violation then null;
  end;
  begin
    update booking_reminder_settings set offsets_minutes = '{60,null}';
    raise exception 'a null reminder time was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into booking_reminder_settings (id) values (false);
    raise exception 'a second reminder settings row was accepted';
  exception when check_violation then null;
  end;
end
$$;

do $$
declare
  i constant uuid := '22222222-2222-4222-8222-222222222281';
  lt constant uuid := '44444444-4444-4444-8444-444444444481';
  ann constant uuid := '33333333-3333-4333-8333-333333333381';
  quiet constant uuid := '55555555-5555-4555-8555-555555555581';
  loud constant uuid := '55555555-5555-4555-8555-555555555582';
  v_count int;
begin
  perform book_classes(null, jsonb_build_array(
    jsonb_build_object('id', quiet, 'instructor_id', i, 'lesson_type_id', lt,
      'starts_at', '2030-02-01T15:00:00Z', 'ends_at', '2030-02-01T16:00:00Z',
      'customer_ids', jsonb_build_array(ann), 'send_emails', false),
    jsonb_build_object('id', loud, 'instructor_id', i, 'lesson_type_id', lt,
      'starts_at', '2030-02-02T15:00:00Z', 'ends_at', '2030-02-02T16:00:00Z',
      'customer_ids', jsonb_build_array(ann))));
  if (select send_emails from classes where id = quiet) then
    raise exception 'book_classes ignored send_emails false';
  end if;
  if not (select send_emails from classes where id = loud) then
    raise exception 'book_classes must default send_emails to true';
  end if;

  insert into booking_reminder_sends (class_id, starts_at, offset_minutes, audience, recipient_id)
  values (loud, '2030-02-02T15:00:00Z', 60, 'customer', ann)
  on conflict do nothing;
  insert into booking_reminder_sends (class_id, starts_at, offset_minutes, audience, recipient_id)
  values (loud, '2030-02-02T10:00:00-05', 60, 'customer', ann)
  on conflict (class_id, starts_at, offset_minutes, audience, recipient_id) do nothing;
  select count(*) into v_count from booking_reminder_sends where class_id = loud;
  if v_count <> 1 then
    raise exception 'a reminder was claimed twice for the same lesson time, got % rows', v_count;
  end if;
  if (select status from booking_reminder_sends where class_id = loud) <> 'claimed' then
    raise exception 'a new reminder claim must start as claimed';
  end if;

  insert into booking_reminder_sends (class_id, starts_at, offset_minutes, audience, recipient_id)
  values (loud, '2030-02-03T15:00:00Z', 60, 'customer', ann),
         (loud, '2030-02-02T15:00:00Z', 1440, 'customer', ann),
         (loud, '2030-02-02T15:00:00Z', 60, 'instructor', i);
  select count(*) into v_count from booking_reminder_sends where class_id = loud;
  if v_count <> 4 then
    raise exception 'a new time, offset or recipient must claim its own reminder, got % rows', v_count;
  end if;

  begin
    update booking_reminder_sends set status = 'queued' where class_id = loud;
    raise exception 'an unknown reminder status was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into booking_reminder_sends (class_id, starts_at, offset_minutes, audience, recipient_id)
    values (loud, '2030-02-02T15:00:00Z', 60, 'admin', i);
    raise exception 'an unknown reminder audience was accepted';
  exception when check_violation then null;
  end;

  delete from classes where id = loud;
  if exists (select 1 from booking_reminder_sends where class_id = loud) then
    raise exception 'deleting a class must delete its reminder claims';
  end if;
end
$$;

rollback;
\echo 'Booking reminders checks passed.'
