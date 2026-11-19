create table if not exists booking_reminder_settings (
  id               boolean primary key default true check (id),
  enabled          boolean not null default true,
  offsets_minutes  int[] not null default '{1440,60}'
                     constraint booking_reminder_settings_offsets_check
                     check (
                       cardinality(offsets_minutes) <= 5
                       and array_position(offsets_minutes, null) is null
                       and 15 <= all (offsets_minutes)
                       and 20160 >= all (offsets_minutes)
                     ),
  enabled_at       timestamptz not null default now(),
  offsets_added_at jsonb not null default '{}',
  updated_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create or replace function public.stamp_booking_reminder_offsets_added_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.offsets_added_at := coalesce(
    (select jsonb_object_agg(
              o::text,
              coalesce(
                case when tg_op = 'UPDATE' and o = any(old.offsets_minutes)
                  then old.offsets_added_at -> o::text
                end,
                to_jsonb(now())
              )
            )
       from unnest(new.offsets_minutes) as o
      where o is not null),
    '{}'::jsonb
  );
  return new;
end;
$$;

revoke all on function public.stamp_booking_reminder_offsets_added_at()
  from public, anon, authenticated;

create or replace trigger booking_reminder_settings_stamp_offsets_added_at
  before insert or update on booking_reminder_settings
  for each row execute function public.stamp_booking_reminder_offsets_added_at();

insert into booking_reminder_settings (id) values (true)
on conflict (id) do nothing;

create or replace trigger booking_reminder_settings_set_updated_at
  before update on booking_reminder_settings
  for each row execute function public.set_updated_at();

create or replace function public.stamp_booking_reminders_enabled_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.enabled and not old.enabled then
    new.enabled_at := now();
  else
    new.enabled_at := old.enabled_at;
  end if;
  return new;
end;
$$;

revoke all on function public.stamp_booking_reminders_enabled_at()
  from public, anon, authenticated;

create or replace trigger booking_reminder_settings_stamp_enabled_at
  before update on booking_reminder_settings
  for each row execute function public.stamp_booking_reminders_enabled_at();

alter table booking_reminder_settings enable row level security;
alter table booking_reminder_settings force row level security;
revoke all on booking_reminder_settings from public, anon, authenticated;

alter table classes
  add column if not exists send_emails boolean not null default true,
  add column if not exists starts_at_set_at timestamptz not null default now();

alter table classes disable trigger classes_set_updated_at;

update classes
   set send_emails = send_emails and source = 'ssms',
       starts_at_set_at = created_at;

alter table classes enable trigger classes_set_updated_at;

create or replace function public.stamp_class_starts_at_set_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' or new.starts_at is distinct from old.starts_at then
    new.starts_at_set_at := now();
  else
    new.starts_at_set_at := old.starts_at_set_at;
  end if;
  return new;
end;
$$;

revoke all on function public.stamp_class_starts_at_set_at()
  from public, anon, authenticated;

create or replace trigger classes_stamp_starts_at_set_at
  before insert or update on classes
  for each row execute function public.stamp_class_starts_at_set_at();

create table if not exists booking_reminder_sends (
  id              uuid primary key default gen_random_uuid(),
  class_id        uuid not null references classes (id) on delete cascade,
  starts_at       timestamptz not null,
  offset_minutes  int not null
                    constraint booking_reminder_sends_offset_check
                    check (offset_minutes between 15 and 20160),
  audience        text not null
                    constraint booking_reminder_sends_audience_check
                    check (audience in ('customer', 'instructor')),
  recipient_id    uuid not null,
  status          text not null default 'claimed'
                    constraint booking_reminder_sends_status_check
                    check (status in ('claimed', 'sent', 'skipped', 'failed')),
  reason          text
                    constraint booking_reminder_sends_reason_check
                    check (
                      reason is null
                      or (status = 'failed' and reason = 'stale_claim')
                      or (status = 'skipped' and reason = 'superseded')
                    ),
  claimed_at      timestamptz not null default now(),
  finished_at     timestamptz,
  constraint booking_reminder_sends_key
    unique (class_id, starts_at, offset_minutes, audience, recipient_id)
);

create index if not exists booking_reminder_sends_claimed_at_idx
  on booking_reminder_sends (claimed_at)
  where status = 'claimed';

create or replace function public.claim_booking_reminder(
  p_class_id uuid,
  p_starts_at timestamptz,
  p_offset_minutes int,
  p_audience text,
  p_recipient_id uuid
) returns uuid
language sql
security invoker
set search_path = public
as $$
  insert into booking_reminder_sends (
    class_id, starts_at, offset_minutes, audience, recipient_id
  )
  select c.id, c.starts_at, p_offset_minutes, p_audience, p_recipient_id
    from classes c
    join booking_reminder_settings s
      on s.enabled and p_offset_minutes = any (s.offsets_minutes)
   where c.id = p_class_id
     and c.status = 'scheduled'
     and c.source = 'ssms'
     and c.send_emails
     and c.starts_at = p_starts_at
     and c.starts_at > now()
     and case p_audience
           when 'instructor' then c.instructor_id = p_recipient_id
           when 'customer' then exists (
             select 1 from class_participants p
              where p.class_id = c.id and p.customer_id = p_recipient_id)
           else false
         end
     for share of c
  on conflict (class_id, starts_at, offset_minutes, audience, recipient_id)
    do nothing
  returning id;
$$;

revoke all on function public.claim_booking_reminder(uuid, timestamptz, int, text, uuid)
  from public, anon, authenticated;
grant execute on function public.claim_booking_reminder(uuid, timestamptz, int, text, uuid)
  to service_role;

alter table booking_reminder_sends enable row level security;
alter table booking_reminder_sends force row level security;
revoke all on booking_reminder_sends from public, anon, authenticated;

create or replace function public.book_classes(
  p_series jsonb,
  p_classes jsonb
) returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_class jsonb;
  v_conflict uuid;
begin
  if p_series is not null then
    insert into class_series (id, rule, count, created_by)
    values (
      (p_series->>'id')::uuid,
      'weekly',
      (p_series->>'count')::int,
      (p_series->>'created_by')::uuid
    );
  end if;

  for v_class in select value from jsonb_array_elements(p_classes) loop
    perform pg_advisory_xact_lock(
      hashtextextended('classes:' || (v_class->>'instructor_id'), 0)
    );
    select c.id into v_conflict
      from classes c
     where c.instructor_id = (v_class->>'instructor_id')::uuid
       and c.status <> 'cancelled'
       and c.starts_at < (v_class->>'ends_at')::timestamptz
       and c.ends_at > (v_class->>'starts_at')::timestamptz
     limit 1;
    if v_conflict is not null then
      raise exception 'class % overlaps an existing class', v_conflict
        using errcode = 'SB409';
    end if;

    insert into classes (
      id, instructor_id, lesson_type_id, location_id, starts_at, ends_at,
      status, source, google_calendar_id, google_event_id, notes, created_by,
      series_id, google_sync_status, send_emails
    ) values (
      (v_class->>'id')::uuid,
      (v_class->>'instructor_id')::uuid,
      (v_class->>'lesson_type_id')::uuid,
      (v_class->>'location_id')::uuid,
      (v_class->>'starts_at')::timestamptz,
      (v_class->>'ends_at')::timestamptz,
      coalesce(v_class->>'status', 'scheduled'),
      'ssms',
      v_class->>'google_calendar_id',
      null,
      v_class->>'notes',
      (v_class->>'created_by')::uuid,
      (p_series->>'id')::uuid,
      case when v_class->>'google_calendar_id' is null then 'ok' else 'pending' end,
      coalesce((v_class->>'send_emails')::boolean, true)
    );

    insert into class_participants (class_id, customer_id)
    select (v_class->>'id')::uuid, value::uuid
      from jsonb_array_elements_text(coalesce(v_class->'customer_ids', '[]'::jsonb));
  end loop;
end;
$$;

revoke all on function public.book_classes(jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.book_classes(jsonb, jsonb)
  to service_role;
