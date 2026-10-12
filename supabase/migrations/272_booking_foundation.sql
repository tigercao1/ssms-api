create schema if not exists extensions;
create extension if not exists btree_gist with schema extensions;

create table if not exists instructor_calendars (
  instructor_id       uuid primary key references instructors (id) on delete cascade,
  google_calendar_id  text not null
                        constraint instructor_calendars_google_calendar_id_check
                        check (char_length(google_calendar_id) between 1 and 320),
  calendar_summary    text
                        constraint instructor_calendars_calendar_summary_check
                        check (char_length(calendar_summary) <= 500),
  match_status        text not null default 'confirmed'
                        constraint instructor_calendars_match_status_check
                        check (match_status in ('suggested', 'confirmed')),
  updated_by          uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create unique index if not exists instructor_calendars_google_calendar_id_key
  on instructor_calendars (google_calendar_id);

create table if not exists customers (
  id                   uuid primary key default gen_random_uuid(),
  shopify_customer_id  bigint not null unique,
  first_name           text,
  last_name            text,
  email                text,
  phone                text,
  shopify_updated_at   timestamptz,
  search_text          text generated always as (
                         lower(
                           coalesce(first_name, '') || ' ' || coalesce(last_name, '') || ' ' ||
                           coalesce(last_name, '') || coalesce(first_name, '') || ' ' ||
                           coalesce(email, '') || ' ' || coalesce(phone, '') || ' ' ||
                           regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g')
                         )
                       ) stored,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists customers_email_idx on customers (lower(email));
create index if not exists customers_phone_idx on customers (phone);
create index if not exists customers_name_idx on customers (lower(last_name), lower(first_name));
create index if not exists customers_shopify_updated_at_idx on customers (shopify_updated_at);

create table if not exists lesson_types (
  id            uuid primary key default gen_random_uuid(),
  name_en       text not null
                  constraint lesson_types_name_en_check
                  check (char_length(btrim(name_en)) between 1 and 200),
  name_zh       text
                  constraint lesson_types_name_zh_check
                  check (char_length(name_zh) <= 200),
  group_size    int
                  constraint lesson_types_group_size_check
                  check (group_size > 0),
  duration_min  int not null
                  constraint lesson_types_duration_min_check
                  check (duration_min between 1 and 1440),
  is_promo      boolean not null default false,
  active        boolean not null default true,
  sort_order    int not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index if not exists lesson_types_name_en_key on lesson_types (lower(btrim(name_en)));

create table if not exists pay_rates (
  id              uuid primary key default gen_random_uuid(),
  lesson_type_id  uuid not null references lesson_types (id),
  instructor_id   uuid references instructors (id) on delete cascade,
  hourly_rate     numeric(10, 2) not null
                    constraint pay_rates_hourly_rate_check
                    check (hourly_rate >= 0),
  currency        text not null default 'CAD'
                    constraint pay_rates_currency_check
                    check (currency ~ '^[A-Z]{3}$'),
  effective_from  date not null,
  effective_to    date,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint pay_rates_effective_range_check
    check (effective_to is null or effective_to >= effective_from),
  constraint pay_rates_no_overlap exclude using gist (
    lesson_type_id with =,
    (coalesce(instructor_id, '00000000-0000-0000-0000-000000000000'::uuid)) with =,
    (daterange(effective_from, effective_to, '[]')) with &&
  )
);

create index if not exists pay_rates_instructor_id_idx on pay_rates (instructor_id);

create table if not exists classes (
  id                  uuid primary key default gen_random_uuid(),
  instructor_id       uuid not null references instructors (id),
  lesson_type_id      uuid references lesson_types (id),
  location_id         uuid references teaching_locations (id) on delete set null,
  starts_at           timestamptz not null,
  ends_at             timestamptz not null,
  status              text not null default 'scheduled'
                        constraint classes_status_check
                        check (status in ('scheduled', 'completed', 'no_show', 'cancelled')),
  source              text not null default 'ssms'
                        constraint classes_source_check
                        check (source in ('ssms', 'app_import', 'app_webhook')),
  google_calendar_id  text,
  google_event_id     text,
  notes               text,
  created_by          uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint classes_time_range_check check (ends_at > starts_at)
);

create index if not exists classes_instructor_id_starts_at_idx
  on classes (instructor_id, starts_at);
create index if not exists classes_starts_at_idx on classes (starts_at);
create index if not exists classes_lesson_type_id_idx on classes (lesson_type_id);
create unique index if not exists classes_google_event_key
  on classes (google_calendar_id, google_event_id)
  where google_event_id is not null;

create table if not exists class_participants (
  class_id     uuid not null references classes (id) on delete cascade,
  customer_id  uuid not null references customers (id),
  attendance   text not null default 'expected'
                 constraint class_participants_attendance_check
                 check (attendance in ('expected', 'attended', 'no_show')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (class_id, customer_id)
);

create index if not exists class_participants_customer_id_idx
  on class_participants (customer_id);

create or replace trigger instructor_calendars_set_updated_at
  before update on instructor_calendars
  for each row execute function public.set_updated_at();

create or replace trigger customers_set_updated_at
  before update on customers
  for each row execute function public.set_updated_at();

create or replace trigger lesson_types_set_updated_at
  before update on lesson_types
  for each row execute function public.set_updated_at();

create or replace trigger pay_rates_set_updated_at
  before update on pay_rates
  for each row execute function public.set_updated_at();

create or replace trigger classes_set_updated_at
  before update on classes
  for each row execute function public.set_updated_at();

create or replace trigger class_participants_set_updated_at
  before update on class_participants
  for each row execute function public.set_updated_at();

alter table instructor_calendars enable row level security;
alter table instructor_calendars force row level security;
revoke all on instructor_calendars from public, anon, authenticated;

alter table customers enable row level security;
alter table customers force row level security;
revoke all on customers from public, anon, authenticated;

alter table lesson_types enable row level security;
alter table lesson_types force row level security;
revoke all on lesson_types from public, anon, authenticated;

alter table pay_rates enable row level security;
alter table pay_rates force row level security;
revoke all on pay_rates from public, anon, authenticated;

alter table classes enable row level security;
alter table classes force row level security;
revoke all on classes from public, anon, authenticated;

alter table class_participants enable row level security;
alter table class_participants force row level security;
revoke all on class_participants from public, anon, authenticated;
