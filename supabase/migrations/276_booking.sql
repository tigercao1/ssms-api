create table if not exists class_series (
  id          uuid primary key default gen_random_uuid(),
  rule        text not null default 'weekly'
                constraint class_series_rule_check
                check (rule in ('weekly')),
  count       int not null
                constraint class_series_count_check
                check (count between 2 and 12),
  created_by  uuid,
  created_at  timestamptz not null default now()
);

alter table classes
  add column if not exists series_id uuid references class_series (id) on delete set null;

create index if not exists classes_series_id_idx
  on classes (series_id)
  where series_id is not null;

alter table class_series enable row level security;
alter table class_series force row level security;
revoke all on class_series from public, anon, authenticated;

alter table classes
  add column if not exists google_sync_status text not null default 'ok'
    constraint classes_google_sync_status_check
    check (google_sync_status in ('ok', 'pending', 'failed')),
  add column if not exists google_sync_error text,
  add column if not exists google_sync_attempts int not null default 0,
  add column if not exists google_synced_at timestamptz,
  add column if not exists google_event_seq int not null default 0;

create index if not exists classes_google_sync_open_idx
  on classes (updated_at)
  where google_sync_status <> 'ok';

create table if not exists google_event_deletions (
  id                  uuid primary key default gen_random_uuid(),
  google_calendar_id  text not null,
  google_event_id     text not null,
  class_id            uuid references classes (id) on delete set null,
  attempts            int not null default 0,
  last_error          text,
  last_attempt_at     timestamptz,
  created_at          timestamptz not null default now(),
  constraint google_event_deletions_event_key
    unique (google_calendar_id, google_event_id)
);

create index if not exists google_event_deletions_class_id_idx
  on google_event_deletions (class_id)
  where class_id is not null;

alter table google_event_deletions enable row level security;
alter table google_event_deletions force row level security;
revoke all on google_event_deletions from public, anon, authenticated;

create or replace function public.class_google_event_id(
  p_class_id uuid,
  p_seq int
) returns text
language sql
immutable
set search_path = public
as $$
  select 'ssms' || replace(p_class_id::text, '-', '') || p_seq::text;
$$;

revoke all on function public.class_google_event_id(uuid, int)
  from public, anon, authenticated;
grant execute on function public.class_google_event_id(uuid, int)
  to service_role;

create table if not exists booking_settings (
  id                 boolean primary key default true check (id),
  day_start_time     time not null default '08:00',
  day_end_time       time not null default '18:00',
  slot_minutes       int not null default 30
                       constraint booking_settings_slot_minutes_check
                       check (slot_minutes in (15, 30, 60)),
  weekday_overrides  jsonb not null default '{}'::jsonb
                       constraint booking_settings_weekday_overrides_check
                       check (jsonb_typeof(weekday_overrides) = 'object'),
  updated_by         uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint booking_settings_day_range_check
    check (day_end_time > day_start_time)
);

insert into booking_settings (id) values (true)
on conflict (id) do nothing;

create or replace trigger booking_settings_set_updated_at
  before update on booking_settings
  for each row execute function public.set_updated_at();

alter table booking_settings enable row level security;
alter table booking_settings force row level security;
revoke all on booking_settings from public, anon, authenticated;

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
      series_id, google_sync_status
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
      case when v_class->>'google_calendar_id' is null then 'ok' else 'pending' end
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

create or replace function public.rebook_class(
  p_class_id uuid,
  p_class jsonb,
  p_customer_ids jsonb
) returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_conflict uuid;
  v_current classes%rowtype;
  v_calendar text := p_class->>'google_calendar_id';
  v_drop boolean;
  v_sync boolean;
begin
  perform pg_advisory_xact_lock(
    hashtextextended('classes:' || (p_class->>'instructor_id'), 0)
  );
  select c.id into v_conflict
    from classes c
   where c.instructor_id = (p_class->>'instructor_id')::uuid
     and c.id <> p_class_id
     and c.status <> 'cancelled'
     and c.starts_at < (p_class->>'ends_at')::timestamptz
     and c.ends_at > (p_class->>'starts_at')::timestamptz
   limit 1;
  if v_conflict is not null then
    raise exception 'class % overlaps an existing class', v_conflict
      using errcode = 'SB409';
  end if;

  select * into v_current
    from classes
   where id = p_class_id
     and status <> 'cancelled'
     for update;
  if not found then
    raise exception 'class % not found or cancelled', p_class_id
      using errcode = 'P0002';
  end if;

  v_drop := v_current.google_calendar_id is not null
    and v_current.google_calendar_id is distinct from v_calendar;
  v_sync := v_calendar is not null or v_drop;
  if v_drop then
    insert into google_event_deletions (google_calendar_id, google_event_id, class_id)
    values (
      v_current.google_calendar_id,
      coalesce(
        v_current.google_event_id,
        class_google_event_id(p_class_id, v_current.google_event_seq)
      ),
      p_class_id
    )
    on conflict (google_calendar_id, google_event_id) do nothing;
  end if;

  update classes set
    instructor_id = (p_class->>'instructor_id')::uuid,
    lesson_type_id = (p_class->>'lesson_type_id')::uuid,
    starts_at = (p_class->>'starts_at')::timestamptz,
    ends_at = (p_class->>'ends_at')::timestamptz,
    google_calendar_id = v_calendar,
    google_event_id = case when v_drop then null else google_event_id end,
    google_event_seq = google_event_seq + case when v_drop then 1 else 0 end,
    google_sync_status = case when v_sync then 'pending' else google_sync_status end,
    google_sync_error = case when v_sync then null else google_sync_error end,
    google_sync_attempts = case when v_sync then 0 else google_sync_attempts end,
    notes = p_class->>'notes'
  where id = p_class_id;

  if p_customer_ids is not null then
    delete from class_participants
     where class_id = p_class_id
       and customer_id not in (
         select value::uuid from jsonb_array_elements_text(p_customer_ids)
       );
    insert into class_participants (class_id, customer_id)
    select p_class_id, value::uuid
      from jsonb_array_elements_text(p_customer_ids)
    on conflict (class_id, customer_id) do nothing;
  end if;
end;
$$;

revoke all on function public.rebook_class(uuid, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.rebook_class(uuid, jsonb, jsonb)
  to service_role;

create or replace function public.set_class_status(
  p_class_id uuid,
  p_status text
) returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_class classes%rowtype;
  v_conflict uuid;
  v_drop boolean;
  v_sync boolean;
begin
  select * into v_class from classes where id = p_class_id;
  if not found then
    raise exception 'class % not found', p_class_id
      using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('classes:' || v_class.instructor_id::text, 0)
  );
  select * into v_class from classes where id = p_class_id for update;

  if v_class.status = 'cancelled' and p_status <> 'cancelled' then
    select c.id into v_conflict
      from classes c
     where c.instructor_id = v_class.instructor_id
       and c.id <> p_class_id
       and c.status <> 'cancelled'
       and c.starts_at < v_class.ends_at
       and c.ends_at > v_class.starts_at
     limit 1;
    if v_conflict is not null then
      raise exception 'class % overlaps an existing class', v_conflict
        using errcode = 'SB409';
    end if;
  end if;

  if p_status = 'cancelled' and v_class.status <> 'cancelled' then
    v_drop := v_class.google_calendar_id is not null;
    if v_drop then
      insert into google_event_deletions (google_calendar_id, google_event_id, class_id)
      values (
        v_class.google_calendar_id,
        coalesce(
          v_class.google_event_id,
          class_google_event_id(p_class_id, v_class.google_event_seq)
        ),
        p_class_id
      )
      on conflict (google_calendar_id, google_event_id) do nothing;
    end if;
    update classes set
      status = p_status,
      google_event_id = null,
      google_event_seq = google_event_seq + case when v_drop then 1 else 0 end,
      google_sync_status = case when v_drop then 'pending' else 'ok' end,
      google_sync_error = null,
      google_sync_attempts = 0
    where id = p_class_id;
  elsif v_class.status = 'cancelled' and p_status <> 'cancelled' then
    v_sync := v_class.google_calendar_id is not null;
    update classes set
      status = p_status,
      google_sync_status = case when v_sync then 'pending' else 'ok' end,
      google_sync_error = null,
      google_sync_attempts = 0
    where id = p_class_id;
  else
    update classes set status = p_status where id = p_class_id;
  end if;
end;
$$;

revoke all on function public.set_class_status(uuid, text)
  from public, anon, authenticated;
grant execute on function public.set_class_status(uuid, text)
  to service_role;

create or replace function public.finish_class_google_sync(
  p_class_id uuid,
  p_version timestamptz,
  p_calendar_id text,
  p_event_id text,
  p_error text
) returns text
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_class classes%rowtype;
  v_found boolean;
begin
  select * into v_class from classes where id = p_class_id for update;
  v_found := found;

  if p_event_id is not null then
    if v_found
       and v_class.status <> 'cancelled'
       and v_class.google_calendar_id = p_calendar_id
       and coalesce(v_class.google_event_id, p_event_id) = p_event_id then
      if v_class.google_event_id is null then
        update classes set google_event_id = p_event_id where id = p_class_id;
      end if;
    else
      insert into google_event_deletions (google_calendar_id, google_event_id, class_id)
      values (p_calendar_id, p_event_id, case when v_found then p_class_id end)
      on conflict (google_calendar_id, google_event_id) do nothing;
    end if;
  end if;

  if not v_found then
    return 'missing';
  end if;
  if v_class.updated_at is distinct from p_version then
    return 'stale';
  end if;

  update classes set
    google_sync_status = case when p_error is null then 'ok' else 'failed' end,
    google_sync_error = p_error,
    google_sync_attempts = case when p_error is null then 0 else google_sync_attempts + 1 end,
    google_synced_at = case when p_error is null then now() else google_synced_at end
  where id = p_class_id;
  return case when p_error is null then 'ok' else 'failed' end;
end;
$$;

revoke all on function public.finish_class_google_sync(uuid, timestamptz, text, text, text)
  from public, anon, authenticated;
grant execute on function public.finish_class_google_sync(uuid, timestamptz, text, text, text)
  to service_role;
