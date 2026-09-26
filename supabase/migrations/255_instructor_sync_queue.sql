create table if not exists instructor_sync_queue (
  instructor_id  uuid primary key,
  enqueued_at    timestamptz not null default now(),
  attempts       int not null default 0,
  last_error     text
);

create index if not exists instructor_sync_queue_enqueued_at_idx
  on instructor_sync_queue (enqueued_at);

create table if not exists instructor_shopify_state (
  instructor_id          uuid primary key,
  shopify_metaobject_id  text,
  shopify_photo_file_id  text,
  synced_photo_version   timestamptz,
  last_synced_at         timestamptz,
  last_status            text
);

alter table instructor_sync_queue enable row level security;
alter table instructor_sync_queue force row level security;
revoke all on instructor_sync_queue from anon, authenticated;

alter table instructor_shopify_state enable row level security;
alter table instructor_shopify_state force row level security;
revoke all on instructor_shopify_state from anon, authenticated;

alter table instructors add column if not exists profile_photo_version timestamptz;

create or replace function public.set_profile_photo_version()
returns trigger
language plpgsql
as $$
begin
  new.profile_photo_version = now();
  return new;
end;
$$;

drop trigger if exists instructors_set_profile_photo_version on instructors;
create trigger instructors_set_profile_photo_version
  before update on instructors
  for each row
  when (old.profile_photo_url is distinct from new.profile_photo_url)
  execute function public.set_profile_photo_version();

create or replace function public.bump_profile_photo_version(
  p_instructor_id uuid
) returns void
language sql
as $$
  update instructors
     set profile_photo_version = now()
   where id = p_instructor_id;
$$;

revoke all on function public.bump_profile_photo_version(uuid)
  from anon, authenticated;

create or replace function public.enqueue_instructor_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into instructor_sync_queue (instructor_id)
  select distinct ids.instructor_id
    from (values
      ((to_jsonb(old) ->> tg_argv[0])::uuid),
      ((to_jsonb(new) ->> tg_argv[0])::uuid)
    ) as ids (instructor_id)
   where ids.instructor_id is not null
  on conflict (instructor_id) do update set enqueued_at = now();
  return null;
end;
$$;

drop trigger if exists instructors_enqueue_sync on instructors;
create trigger instructors_enqueue_sync
  after insert or update or delete on instructors
  for each row execute function public.enqueue_instructor_sync('id');

drop trigger if exists instructors_teaching_locations_enqueue_sync
  on instructors_teaching_locations;
create trigger instructors_teaching_locations_enqueue_sync
  after insert or update or delete on instructors_teaching_locations
  for each row execute function public.enqueue_instructor_sync('instructor_id');

drop trigger if exists instructors_languages_enqueue_sync
  on instructors_languages;
create trigger instructors_languages_enqueue_sync
  after insert or update or delete on instructors_languages
  for each row execute function public.enqueue_instructor_sync('instructor_id');

drop trigger if exists instructors_course_levels_offered_enqueue_sync
  on instructors_course_levels_offered;
create trigger instructors_course_levels_offered_enqueue_sync
  after insert or update or delete on instructors_course_levels_offered
  for each row execute function public.enqueue_instructor_sync('instructor_id');

drop trigger if exists instructor_certifications_enqueue_sync
  on instructor_certifications;
create trigger instructor_certifications_enqueue_sync
  after insert or update or delete on instructor_certifications
  for each row execute function public.enqueue_instructor_sync('instructor_id');

drop trigger if exists instructor_trainer_status_enqueue_sync
  on instructor_trainer_status;
create trigger instructor_trainer_status_enqueue_sync
  after insert or update or delete on instructor_trainer_status
  for each row execute function public.enqueue_instructor_sync('instructor_id');

create or replace function public.enqueue_instructor_sync_for_reference()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  execute format(
    'insert into instructor_sync_queue (instructor_id)
     select distinct instructor_id from %I where %I = $1
     on conflict (instructor_id) do update set enqueued_at = now()',
    tg_argv[0], tg_argv[1]
  ) using new.id;
  return null;
end;
$$;

drop trigger if exists teaching_locations_enqueue_sync on teaching_locations;
create trigger teaching_locations_enqueue_sync
  after update on teaching_locations
  for each row
  when (old.name is distinct from new.name
        or old.is_active is distinct from new.is_active)
  execute function public.enqueue_instructor_sync_for_reference(
    'instructors_teaching_locations', 'teaching_location_id');

drop trigger if exists languages_enqueue_sync on languages;
create trigger languages_enqueue_sync
  after update on languages
  for each row
  when (old.name is distinct from new.name
        or old.is_active is distinct from new.is_active)
  execute function public.enqueue_instructor_sync_for_reference(
    'instructors_languages', 'language_id');

drop trigger if exists course_levels_offered_enqueue_sync on course_levels_offered;
create trigger course_levels_offered_enqueue_sync
  after update on course_levels_offered
  for each row
  when (old.name is distinct from new.name
        or old.is_active is distinct from new.is_active)
  execute function public.enqueue_instructor_sync_for_reference(
    'instructors_course_levels_offered', 'course_level_offered_id');
