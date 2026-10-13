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
      series_id
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
      v_class->>'google_event_id',
      v_class->>'notes',
      (v_class->>'created_by')::uuid,
      (p_series->>'id')::uuid
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

  update classes set
    instructor_id = (p_class->>'instructor_id')::uuid,
    lesson_type_id = (p_class->>'lesson_type_id')::uuid,
    starts_at = (p_class->>'starts_at')::timestamptz,
    ends_at = (p_class->>'ends_at')::timestamptz,
    google_calendar_id = p_class->>'google_calendar_id',
    google_event_id = p_class->>'google_event_id',
    notes = p_class->>'notes'
  where id = p_class_id
    and status <> 'cancelled';

  if not found then
    raise exception 'class % not found or cancelled', p_class_id
      using errcode = 'P0002';
  end if;

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
begin
  select * into v_class from classes where id = p_class_id;
  if not found then
    raise exception 'class % not found', p_class_id
      using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('classes:' || v_class.instructor_id::text, 0)
  );

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

  update classes set
    status = p_status,
    google_calendar_id = case when p_status = 'cancelled' then null else google_calendar_id end,
    google_event_id = case when p_status = 'cancelled' then null else google_event_id end
  where id = p_class_id;
end;
$$;

revoke all on function public.set_class_status(uuid, text)
  from public, anon, authenticated;
grant execute on function public.set_class_status(uuid, text)
  to service_role;
