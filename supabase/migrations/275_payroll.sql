create table if not exists payroll_settings (
  id           boolean primary key default true
                 constraint payroll_settings_singleton_check check (id),
  anchor_date  date not null default date '2025-12-15',
  period_days  int not null default 14
                 constraint payroll_settings_period_days_check check (period_days = 14),
  updated_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

insert into payroll_settings (id) values (true) on conflict (id) do nothing;

create table if not exists payroll_periods (
  id            uuid primary key default gen_random_uuid(),
  starts_on     date not null,
  ends_on       date not null,
  status        text not null default 'open'
                  constraint payroll_periods_status_check
                  check (status in ('open', 'finalized')),
  finalized_at  timestamptz,
  finalized_by  uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint payroll_periods_range_check check (ends_on = starts_on + 13),
  constraint payroll_periods_finalized_check
    check ((status = 'finalized') = (finalized_at is not null))
);

create unique index if not exists payroll_periods_starts_on_key
  on payroll_periods (starts_on);

create table if not exists payroll_lines (
  id              uuid primary key default gen_random_uuid(),
  period_id       uuid not null references payroll_periods (id) on delete cascade,
  instructor_id   uuid not null references instructors (id),
  class_id        uuid references classes (id),
  kind            text not null
                    constraint payroll_lines_kind_check
                    check (kind in ('class', 'adjustment')),
  description     text
                    constraint payroll_lines_description_check
                    check (char_length(description) <= 500),
  lesson_type_id  uuid references lesson_types (id),
  class_status    text,
  starts_at       timestamptz,
  ends_at         timestamptz,
  customer_names  text[] not null default '{}',
  minutes         int
                    constraint payroll_lines_minutes_check check (minutes >= 0),
  hourly_rate     numeric(10, 2),
  currency        text not null default 'CAD'
                    constraint payroll_lines_currency_check
                    check (currency ~ '^[A-Z]{3}$'),
  amount          numeric(12, 2) not null,
  flags           text[] not null default '{}',
  created_by      uuid,
  created_at      timestamptz not null default now(),
  constraint payroll_lines_kind_class_check
    check ((kind = 'class') = (class_id is not null))
);

create unique index if not exists payroll_lines_period_class_key
  on payroll_lines (period_id, class_id)
  where class_id is not null;
create index if not exists payroll_lines_period_id_idx on payroll_lines (period_id);
create index if not exists payroll_lines_instructor_id_idx on payroll_lines (instructor_id);
create index if not exists payroll_lines_class_id_idx on payroll_lines (class_id);

create or replace trigger payroll_settings_set_updated_at
  before update on payroll_settings
  for each row execute function public.set_updated_at();

create or replace trigger payroll_periods_set_updated_at
  before update on payroll_periods
  for each row execute function public.set_updated_at();

create or replace function public.payroll_lines_guard_finalized()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if exists (
    select 1 from payroll_periods p
     where p.status = 'finalized'
       and p.id in (
         case when tg_op = 'INSERT' then null else old.period_id end,
         case when tg_op = 'DELETE' then null else new.period_id end
       )
  ) then
    raise exception 'payroll period is finalized' using errcode = '55000';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

revoke all on function public.payroll_lines_guard_finalized()
  from public, anon, authenticated;

create or replace trigger payroll_lines_guard_finalized
  before insert or update or delete on payroll_lines
  for each row execute function public.payroll_lines_guard_finalized();

create or replace function public.payroll_finalize(
  p_period_id uuid,
  p_lines jsonb,
  p_actor uuid
) returns void
language plpgsql
set search_path = public
as $$
declare
  v_status text;
begin
  select status into v_status from payroll_periods
   where id = p_period_id
   for update;
  if not found then
    raise exception 'payroll period not found' using errcode = 'P0002';
  end if;
  if v_status <> 'open' then
    raise exception 'payroll period is finalized' using errcode = '55000';
  end if;

  delete from payroll_lines where period_id = p_period_id and kind = 'class';

  insert into payroll_lines (
    period_id, instructor_id, class_id, kind, description, lesson_type_id,
    class_status, starts_at, ends_at, customer_names, minutes, hourly_rate,
    currency, amount, flags, created_by
  )
  select p_period_id, l.instructor_id, l.class_id, 'class', l.description,
         l.lesson_type_id, l.class_status, l.starts_at, l.ends_at,
         coalesce(l.customer_names, '{}'), l.minutes,
         l.hourly_rate, coalesce(l.currency, 'CAD'), l.amount,
         coalesce(l.flags, '{}'), p_actor
    from jsonb_to_recordset(coalesce(p_lines, '[]'::jsonb)) as l (
      instructor_id uuid, class_id uuid, description text, lesson_type_id uuid,
      class_status text, starts_at timestamptz, ends_at timestamptz,
      customer_names text[], minutes int, hourly_rate numeric, currency text,
      amount numeric, flags text[]
    );

  update payroll_periods
     set status = 'finalized', finalized_at = now(), finalized_by = p_actor
   where id = p_period_id;
end;
$$;

revoke all on function public.payroll_finalize(uuid, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function public.payroll_finalize(uuid, jsonb, uuid)
  to service_role;

create or replace function public.payroll_reopen(p_period_id uuid)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_status text;
begin
  select status into v_status from payroll_periods
   where id = p_period_id
   for update;
  if not found then
    raise exception 'payroll period not found' using errcode = 'P0002';
  end if;
  if v_status <> 'finalized' then
    raise exception 'payroll period is not finalized' using errcode = '55000';
  end if;

  update payroll_periods
     set status = 'open', finalized_at = null, finalized_by = null
   where id = p_period_id;

  delete from payroll_lines where period_id = p_period_id and kind = 'class';
end;
$$;

revoke all on function public.payroll_reopen(uuid)
  from public, anon, authenticated;
grant execute on function public.payroll_reopen(uuid)
  to service_role;

create or replace function public.payroll_set_anchor(
  p_anchor date,
  p_actor uuid
) returns void
language plpgsql
set search_path = public
as $$
begin
  lock table payroll_periods in share row exclusive mode;
  if exists (select 1 from payroll_periods where status = 'finalized') then
    raise exception 'a payroll period is finalized' using errcode = '55000';
  end if;
  if exists (
    select 1 from payroll_lines l
      join payroll_periods p on p.id = l.period_id
     where mod(p.starts_on - p_anchor, 14) <> 0
  ) then
    raise exception 'payroll adjustments exist' using errcode = '55000';
  end if;

  delete from payroll_periods
   where mod(starts_on - p_anchor, 14) <> 0;

  insert into payroll_settings (id, anchor_date, updated_by)
  values (true, p_anchor, p_actor)
  on conflict (id) do update
     set anchor_date = excluded.anchor_date, updated_by = excluded.updated_by;
end;
$$;

revoke all on function public.payroll_set_anchor(date, uuid)
  from public, anon, authenticated;
grant execute on function public.payroll_set_anchor(date, uuid)
  to service_role;

alter table payroll_settings enable row level security;
alter table payroll_settings force row level security;
revoke all on payroll_settings from public, anon, authenticated;

alter table payroll_periods enable row level security;
alter table payroll_periods force row level security;
revoke all on payroll_periods from public, anon, authenticated;

alter table payroll_lines enable row level security;
alter table payroll_lines force row level security;
revoke all on payroll_lines from public, anon, authenticated;
