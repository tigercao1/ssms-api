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
  if (select enabled_at from booking_reminder_settings) is null then
    raise exception 'booking_reminder_settings must record when reminders were turned on';
  end if;
  if (select (offsets_added_at ->> '1440')::timestamptz is distinct from created_at
             or (offsets_added_at ->> '60')::timestamptz is distinct from created_at
             or (select count(*) from jsonb_object_keys(offsets_added_at)) <> 2
        from booking_reminder_settings) then
    raise exception 'booking_reminder_settings must record when each default offset was added';
  end if;
  alter table booking_reminder_settings disable trigger booking_reminder_settings_stamp_offsets_added_at;
  update booking_reminder_settings
     set offsets_added_at = '{"1440": "2000-01-01T00:00:00+00:00", "60": "2000-01-01T00:00:00+00:00"}';
  alter table booking_reminder_settings enable trigger booking_reminder_settings_stamp_offsets_added_at;
  update booking_reminder_settings
     set offsets_minutes = '{10080,1440,60}', offsets_added_at = '{"10080": "2001-01-01T00:00:00+00:00"}';
  if (select offsets_added_at from booking_reminder_settings)
     <> jsonb_build_object('10080', to_jsonb(now()), '1440', '2000-01-01T00:00:00+00:00', '60', '2000-01-01T00:00:00+00:00') then
    raise exception 'adding an offset must stamp only the new offset, got %',
      (select offsets_added_at from booking_reminder_settings);
  end if;
  alter table booking_reminder_settings disable trigger booking_reminder_settings_stamp_offsets_added_at;
  update booking_reminder_settings
     set offsets_added_at = '{"10080": "2000-01-01T00:00:00+00:00", "1440": "2000-01-01T00:00:00+00:00", "60": "2000-01-01T00:00:00+00:00"}';
  alter table booking_reminder_settings enable trigger booking_reminder_settings_stamp_offsets_added_at;
  update booking_reminder_settings set offsets_minutes = '{1440,60}';
  update booking_reminder_settings set offsets_minutes = '{10080,1500,60}';
  if (select offsets_added_at from booking_reminder_settings)
     <> jsonb_build_object('10080', to_jsonb(now()), '1500', to_jsonb(now()), '60', '2000-01-01T00:00:00+00:00') then
    raise exception 'a removed and re-added or changed offset must count as newly added, got %',
      (select offsets_added_at from booking_reminder_settings);
  end if;
  update booking_reminder_settings set enabled = false;
  update booking_reminder_settings set enabled = true, offsets_minutes = '{1440,60}';
  alter table booking_reminder_settings disable trigger booking_reminder_settings_stamp_enabled_at;
  update booking_reminder_settings set enabled_at = '2000-01-01T00:00:00Z';
  alter table booking_reminder_settings enable trigger booking_reminder_settings_stamp_enabled_at;
  update booking_reminder_settings set offsets_minutes = '{60}', enabled_at = '2001-01-01T00:00:00Z';
  update booking_reminder_settings set enabled = false;
  if (select enabled_at from booking_reminder_settings) <> '2000-01-01T00:00:00Z' then
    raise exception 'enabled_at changed without reminders being turned on';
  end if;
  update booking_reminder_settings set enabled = true;
  if (select enabled_at from booking_reminder_settings) <> now() then
    raise exception 'turning reminders on must record enabled_at';
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
  v_set_at timestamptz;
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

  if (select starts_at_set_at from classes where id = loud) <> now() then
    raise exception 'a booked class must record when it got its start time';
  end if;

  alter table classes disable trigger classes_stamp_starts_at_set_at;
  update classes set starts_at_set_at = '2000-01-01T00:00:00Z' where id = loud;
  alter table classes enable trigger classes_stamp_starts_at_set_at;
  update classes set notes = 'moved room' where id = loud;
  update classes set starts_at_set_at = '2001-01-01T00:00:00Z' where id = loud;
  if (select starts_at_set_at from classes where id = loud) <> '2000-01-01T00:00:00Z' then
    raise exception 'starts_at_set_at changed without a new start time';
  end if;
  update classes
     set starts_at = '2030-02-02T17:00:00Z', ends_at = '2030-02-02T18:00:00Z'
   where id = loud;
  if (select starts_at_set_at from classes where id = loud) <> now() then
    raise exception 'a reschedule must record when the class got its new start time';
  end if;

  insert into classes (instructor_id, lesson_type_id, starts_at, ends_at, source, starts_at_set_at)
  values (i, lt, '2030-03-01T15:00:00Z', '2030-03-01T16:00:00Z', 'app_import', '2000-01-01T00:00:00Z')
  returning starts_at_set_at into v_set_at;
  if v_set_at <> now() then
    raise exception 'an insert must not choose its own starts_at_set_at';
  end if;

  update booking_reminder_sends set status = 'failed', reason = 'stale_claim'
   where class_id = loud and offset_minutes = 1440;
  begin
    update booking_reminder_sends set reason = 'stale_claim'
     where class_id = loud and status = 'claimed';
    raise exception 'a stale_claim reason was accepted on a claimed reminder';
  exception when check_violation then null;
  end;
  update booking_reminder_sends set status = 'skipped', reason = 'superseded'
   where class_id = loud and offset_minutes = 1440;
  begin
    update booking_reminder_sends set status = 'failed', reason = 'superseded'
     where class_id = loud and offset_minutes = 1440;
    raise exception 'a superseded reason was accepted on a failed reminder';
  exception when check_violation then null;
  end;
  begin
    update booking_reminder_sends set status = 'skipped', reason = 'stale_claim'
     where class_id = loud and offset_minutes = 1440;
    raise exception 'a stale_claim reason was accepted on a skipped reminder';
  exception when check_violation then null;
  end;
  update booking_reminder_sends set status = 'failed', reason = 'stale_claim'
   where class_id = loud and offset_minutes = 1440;
  begin
    update booking_reminder_sends set reason = 'boom'
     where class_id = loud and offset_minutes = 1440;
    raise exception 'an unknown reminder failure reason was accepted';
  exception when check_violation then null;
  end;

  update booking_reminder_settings set enabled = true, offsets_minutes = '{1440,60}';
  delete from booking_reminder_sends where class_id = loud;
  if claim_booking_reminder(loud, '2030-02-02T15:00:00Z', 60, 'customer', ann) is not null then
    raise exception 'a reminder for the old time of a moved class was claimed';
  end if;
  if claim_booking_reminder(loud, '2030-02-02T17:00:00Z', 60, 'customer', ann) is null then
    raise exception 'a reminder for a scheduled class was not claimed';
  end if;
  if claim_booking_reminder(loud, '2030-02-02T17:00:00Z', 60, 'customer', ann) is not null then
    raise exception 'a reminder was claimed twice';
  end if;
  if claim_booking_reminder(loud, '2030-02-02T17:00:00Z', 60, 'instructor', i) is null then
    raise exception 'the instructor reminder for a scheduled class was not claimed';
  end if;
  if claim_booking_reminder(loud, '2030-02-02T17:00:00Z', 1440, 'instructor', ann) is not null
     or claim_booking_reminder(loud, '2030-02-02T17:00:00Z', 1440, 'customer', i) is not null then
    raise exception 'a reminder was claimed for someone not on the class';
  end if;
  if claim_booking_reminder(loud, '2030-02-02T17:00:00Z', 180, 'customer', ann) is not null then
    raise exception 'a reminder was claimed for an offset that is not configured';
  end if;
  update booking_reminder_settings set enabled = false;
  if claim_booking_reminder(loud, '2030-02-02T17:00:00Z', 1440, 'customer', ann) is not null then
    raise exception 'a reminder was claimed while reminders are turned off';
  end if;
  update booking_reminder_settings set enabled = true;
  if claim_booking_reminder(quiet, '2030-02-01T15:00:00Z', 60, 'customer', ann) is not null then
    raise exception 'a reminder was claimed for a class booked with send_emails false';
  end if;
  perform set_class_status(loud, 'cancelled');
  if claim_booking_reminder(loud, '2030-02-02T17:00:00Z', 1440, 'customer', ann) is not null then
    raise exception 'a reminder was claimed for a cancelled class';
  end if;
  update classes set status = 'scheduled' where id = loud;
  if claim_booking_reminder(loud, '2030-02-02T17:00:00Z', 1440, 'customer', ann) is null then
    raise exception 'a reminder for a class scheduled again was not claimed';
  end if;

  insert into classes (id, instructor_id, lesson_type_id, starts_at, ends_at, source)
  values ('55555555-5555-4555-8555-555555555583', i, lt, now() - interval '1 minute', now() + interval '59 minutes', 'ssms'),
         ('55555555-5555-4555-8555-555555555584', i, lt, '2030-04-01T15:00:00Z', '2030-04-01T16:00:00Z', 'app_import');
  insert into class_participants (class_id, customer_id)
  values ('55555555-5555-4555-8555-555555555583', ann),
         ('55555555-5555-4555-8555-555555555584', ann);
  if claim_booking_reminder('55555555-5555-4555-8555-555555555583', now() - interval '1 minute', 60, 'customer', ann) is not null then
    raise exception 'a reminder was claimed for a class that already started';
  end if;
  if claim_booking_reminder('55555555-5555-4555-8555-555555555584', '2030-04-01T15:00:00Z', 60, 'customer', ann) is not null then
    raise exception 'a reminder was claimed for an imported class';
  end if;

  delete from classes where id = loud;
  if exists (select 1 from booking_reminder_sends where class_id = loud) then
    raise exception 'deleting a class must delete its reminder claims';
  end if;
end
$$;

rollback;
\echo 'Booking reminders checks passed.'
