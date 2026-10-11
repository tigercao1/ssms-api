create table if not exists instructor_calendars (
  instructor_id       uuid primary key references instructors (id) on delete cascade,
  google_calendar_id  text not null
                        constraint instructor_calendars_google_calendar_id_check
                        check (char_length(google_calendar_id) between 1 and 320),
  updated_by          uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table if not exists customers (
  id                   uuid primary key default gen_random_uuid(),
  shopify_customer_id  bigint unique,
  name                 text,
  email                text,
  phone                text,
  wechat_id            text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists customers_email_idx on customers (lower(email));

create table if not exists lesson_products (
  id                  uuid primary key default gen_random_uuid(),
  shopify_product_id  bigint not null,
  shopify_variant_id  bigint not null unique,
  product_title       text not null,
  variant_title       text,
  lesson_type         text not null default 'other'
                        constraint lesson_products_lesson_type_check
                        check (lesson_type in ('private', 'semi_private', 'group', 'other')),
  group_size          int
                        constraint lesson_products_group_size_check
                        check (group_size > 0),
  sessions            int
                        constraint lesson_products_sessions_check
                        check (sessions > 0),
  duration_min        int
                        constraint lesson_products_duration_min_check
                        check (duration_min > 0),
  priced_per_student  boolean not null default false,
  instructor_id       uuid references instructors (id) on delete set null,
  status              text not null default 'suggested'
                        constraint lesson_products_status_check
                        check (status in ('suggested', 'confirmed', 'ignored')),
  price               numeric(10, 2),
  currency            text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists lesson_products_status_idx on lesson_products (status);
create index if not exists lesson_products_shopify_product_id_idx
  on lesson_products (shopify_product_id);
create index if not exists lesson_products_instructor_id_idx
  on lesson_products (instructor_id);

create table if not exists purchases (
  id                    uuid primary key default gen_random_uuid(),
  customer_id           uuid not null references customers (id),
  lesson_product_id     uuid not null references lesson_products (id),
  shopify_order_id      bigint,
  shopify_line_item_id  bigint unique,
  quantity              int not null default 1
                          constraint purchases_quantity_check
                          check (quantity > 0),
  credits_total         int not null
                          constraint purchases_credits_total_check
                          check (credits_total >= 0),
  credits_used          int not null default 0,
  status                text not null default 'active'
                          constraint purchases_status_check
                          check (status in ('active', 'refunded', 'void')),
  purchased_at          timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint purchases_credits_used_check
    check (credits_used between 0 and credits_total)
);

create index if not exists purchases_customer_id_idx on purchases (customer_id);
create index if not exists purchases_lesson_product_id_idx
  on purchases (lesson_product_id);
create index if not exists purchases_shopify_order_id_idx
  on purchases (shopify_order_id);

create table if not exists classes (
  id                  uuid primary key default gen_random_uuid(),
  instructor_id       uuid not null references instructors (id),
  lesson_product_id   uuid references lesson_products (id) on delete set null,
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
create unique index if not exists classes_google_event_key
  on classes (google_calendar_id, google_event_id)
  where google_event_id is not null;

create table if not exists class_participants (
  class_id     uuid not null references classes (id) on delete cascade,
  customer_id  uuid not null references customers (id),
  purchase_id  uuid references purchases (id) on delete set null,
  attendance   text not null default 'expected'
                 constraint class_participants_attendance_check
                 check (attendance in ('expected', 'attended', 'no_show')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (class_id, customer_id)
);

create index if not exists class_participants_customer_id_idx
  on class_participants (customer_id);
create index if not exists class_participants_purchase_id_idx
  on class_participants (purchase_id);

create or replace trigger instructor_calendars_set_updated_at
  before update on instructor_calendars
  for each row execute function public.set_updated_at();

create or replace trigger customers_set_updated_at
  before update on customers
  for each row execute function public.set_updated_at();

create or replace trigger lesson_products_set_updated_at
  before update on lesson_products
  for each row execute function public.set_updated_at();

create or replace trigger purchases_set_updated_at
  before update on purchases
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

alter table lesson_products enable row level security;
alter table lesson_products force row level security;
revoke all on lesson_products from public, anon, authenticated;

alter table purchases enable row level security;
alter table purchases force row level security;
revoke all on purchases from public, anon, authenticated;

alter table classes enable row level security;
alter table classes force row level security;
revoke all on classes from public, anon, authenticated;

alter table class_participants enable row level security;
alter table class_participants force row level security;
revoke all on class_participants from public, anon, authenticated;
