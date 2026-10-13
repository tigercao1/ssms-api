create table if not exists class_imports (
  id            uuid primary key default gen_random_uuid(),
  filename      text not null
                  constraint class_imports_filename_check
                  check (char_length(filename) between 1 and 255),
  uploaded_by   uuid,
  status        text not null default 'draft'
                  constraint class_imports_status_check
                  check (status in ('draft', 'committed', 'discarded')),
  counts        jsonb not null default '{}'::jsonb,
  committed_by  uuid,
  committed_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists class_imports_status_created_at_idx
  on class_imports (status, created_at desc);

create table if not exists class_import_event_map (
  event_name      text primary key
                    constraint class_import_event_map_event_name_check
                    check (char_length(btrim(event_name)) between 1 and 500),
  lesson_type_id  uuid not null references lesson_types (id) on delete cascade,
  updated_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists class_import_rows (
  import_id        uuid not null references class_imports (id) on delete cascade,
  row_no           int not null
                     constraint class_import_rows_row_no_check
                     check (row_no > 0),
  external_id      text not null
                     constraint class_import_rows_external_id_check
                     check (char_length(external_id) between 1 and 200),
  raw              jsonb not null,
  event_name       text,
  instructor_name  text,
  instructor_id    uuid references instructors (id) on delete set null,
  lesson_type_id   uuid references lesson_types (id) on delete set null,
  customer_id      uuid references customers (id) on delete set null,
  starts_at        timestamptz,
  ends_at          timestamptz,
  status_to_set    text
                     constraint class_import_rows_status_to_set_check
                     check (status_to_set in ('scheduled', 'completed', 'cancelled')),
  problems         text[] not null default '{}',
  manual_fields    text[] not null default '{}'
                     constraint class_import_rows_manual_fields_check
                     check (manual_fields <@ array['instructor', 'lesson_type', 'customer']::text[]),
  class_id         uuid references classes (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (import_id, row_no)
);

create index if not exists class_import_rows_external_id_idx
  on class_import_rows (external_id);
create index if not exists class_import_rows_class_id_idx
  on class_import_rows (class_id)
  where class_id is not null;

alter table classes add column if not exists import_external_id text;

create unique index if not exists classes_import_external_id_key
  on classes (import_external_id)
  where import_external_id is not null;

create or replace trigger class_imports_set_updated_at
  before update on class_imports
  for each row execute function public.set_updated_at();

create or replace trigger class_import_event_map_set_updated_at
  before update on class_import_event_map
  for each row execute function public.set_updated_at();

create or replace trigger class_import_rows_set_updated_at
  before update on class_import_rows
  for each row execute function public.set_updated_at();

alter table class_imports enable row level security;
alter table class_imports force row level security;
revoke all on class_imports from public, anon, authenticated;

alter table class_import_event_map enable row level security;
alter table class_import_event_map force row level security;
revoke all on class_import_event_map from public, anon, authenticated;

alter table class_import_rows enable row level security;
alter table class_import_rows force row level security;
revoke all on class_import_rows from public, anon, authenticated;

create or replace function public.class_import_customer_matches(
  p_emails text[],
  p_phones text[]
) returns table (
  id         uuid,
  email_key  text,
  phone_key  text
)
language sql
stable
security invoker
set search_path = public
as $$
  select c.id,
         lower(btrim(c.email)),
         regexp_replace(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g'), '^1([0-9]{10})$', '\1')
  from customers c
  where lower(btrim(c.email)) = any (coalesce(p_emails, '{}'))
     or regexp_replace(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g'), '^1([0-9]{10})$', '\1')
          = any (coalesce(p_phones, '{}'));
$$;

revoke all on function public.class_import_customer_matches(text[], text[])
  from public, anon, authenticated;
grant execute on function public.class_import_customer_matches(text[], text[])
  to service_role;

create or replace function public.commit_class_import(
  p_import_id uuid,
  p_actor uuid
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_status        text;
  v_total         int;
  v_ready         int;
  v_created       int;
  v_participants  int;
  v_linked        int;
  v_counts        jsonb;
  v_blocking      constant text[] := array[
    'instructor_not_found', 'instructor_ambiguous', 'lesson_type_unmapped',
    'invalid_row', 'duplicate_row'
  ];
begin
  select status into v_status
  from class_imports
  where id = p_import_id
  for update;

  if not found then
    raise exception 'class import % not found', p_import_id
      using errcode = 'P0002';
  end if;
  if v_status <> 'draft' then
    raise exception 'class import % is %', p_import_id, v_status
      using errcode = '55000';
  end if;

  select count(*) into v_total
  from class_import_rows
  where import_id = p_import_id;

  create temporary table class_import_ready on commit drop as
  select distinct on (r.external_id) r.*
  from class_import_rows r
  where r.import_id = p_import_id
    and r.instructor_id is not null
    and r.lesson_type_id is not null
    and r.starts_at is not null
    and r.ends_at > r.starts_at
    and r.status_to_set is not null
    and not (r.problems && v_blocking)
  order by r.external_id, r.row_no;

  select count(*) into v_ready from class_import_ready;

  with inserted as (
    insert into classes (
      instructor_id, lesson_type_id, starts_at, ends_at, status, source,
      notes, created_by, import_external_id
    )
    select r.instructor_id, r.lesson_type_id, r.starts_at, r.ends_at,
           case when r.status_to_set = 'scheduled' and r.ends_at <= now()
                then 'completed' else r.status_to_set end,
           'app_import',
           nullif(btrim(r.raw ->> 'internalNotes'), ''),
           p_actor,
           r.external_id
    from class_import_ready r
    on conflict (import_external_id) where import_external_id is not null
      do nothing
    returning id, import_external_id
  ), participants as (
    insert into class_participants (class_id, customer_id)
    select i.id, r.customer_id
    from inserted i
    join class_import_ready r on r.external_id = i.import_external_id
    where r.customer_id is not null
    on conflict do nothing
    returning 1
  )
  select (select count(*) from inserted), (select count(*) from participants)
  into v_created, v_participants;

  update class_import_rows r
  set class_id = c.id
  from classes c, class_import_ready ready
  where r.import_id = p_import_id
    and r.row_no = ready.row_no
    and c.import_external_id = ready.external_id;
  get diagnostics v_linked = row_count;

  drop table class_import_ready;

  v_counts := jsonb_build_object(
    'total', v_total,
    'ready', v_ready,
    'created', v_created,
    'alreadyImported', v_linked - v_created,
    'participants', v_participants,
    'skipped', v_total - v_linked
  );

  update class_imports
  set status = 'committed',
      committed_by = p_actor,
      committed_at = now(),
      counts = counts || jsonb_build_object('commit', v_counts)
  where id = p_import_id;

  return v_counts;
end
$$;

revoke all on function public.commit_class_import(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.commit_class_import(uuid, uuid)
  to service_role;
