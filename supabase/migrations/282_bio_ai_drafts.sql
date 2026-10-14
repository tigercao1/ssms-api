-- Instructor bio refine / translate: per-instructor request log for the daily
-- quota, per-language bio timestamps, and machine-translation flags in the
-- profile RPC. Callers that omit the new patch keys behave as before.
-- A bio timestamp moves when its text changes, unless the statement sets it.

create table if not exists bio_ai_requests (
  id            uuid primary key default gen_random_uuid(),
  instructor_id uuid not null references instructors (id) on delete cascade,
  mode          text not null check (mode in ('refine', 'translate')),
  created_at    timestamptz not null default now()
);

create index if not exists bio_ai_requests_instructor_created_idx
  on bio_ai_requests (instructor_id, created_at);

alter table bio_ai_requests enable row level security;
alter table bio_ai_requests force row level security;
revoke all on bio_ai_requests from public, anon, authenticated;

alter table instructors add column if not exists bio_en_updated_at timestamptz;
alter table instructors add column if not exists bio_zh_updated_at timestamptz;

create or replace function public.stamp_bio_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- Stamp a side whose text changed, unless the statement set its timestamp.
  if tg_op = 'INSERT' then
    if new.bio_en is not null and new.bio_en_updated_at is null then
      new.bio_en_updated_at := now();
    end if;
    if new.bio_zh is not null and new.bio_zh_updated_at is null then
      new.bio_zh_updated_at := now();
    end if;
  else
    if new.bio_en is distinct from old.bio_en
       and new.bio_en_updated_at is not distinct from old.bio_en_updated_at then
      new.bio_en_updated_at := now();
    end if;
    if new.bio_zh is distinct from old.bio_zh
       and new.bio_zh_updated_at is not distinct from old.bio_zh_updated_at then
      new.bio_zh_updated_at := now();
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.stamp_bio_updated_at()
  from public, anon, authenticated;

drop trigger if exists instructors_stamp_bio_updated_at on instructors;
create trigger instructors_stamp_bio_updated_at
  before insert or update of bio_en, bio_zh on instructors
  for each row execute function public.stamp_bio_updated_at();

-- Requests in the rolling 24 h window: count and the oldest timestamp.
create or replace function public.bio_ai_usage(p_instructor_id uuid)
returns table (used int, oldest_at timestamptz)
language sql
stable
set search_path = public
as $$
  select count(*)::int, min(created_at)
    from bio_ai_requests
   where instructor_id = p_instructor_id
     and created_at > now() - interval '24 hours';
$$;

-- Reserves a slot when fewer than p_limit requests are in the window.
-- request_id is null when the limit is reached. Serialised per instructor.
create or replace function public.reserve_bio_ai_request(
  p_instructor_id uuid,
  p_mode text,
  p_limit int
)
returns table (request_id uuid, used int, oldest_at timestamptz)
language plpgsql
set search_path = public
as $$
begin
  perform pg_advisory_xact_lock(
    hashtext('bio_ai_requests'), hashtext(p_instructor_id::text));

  select u.used, u.oldest_at into used, oldest_at
    from public.bio_ai_usage(p_instructor_id) u;

  if used < p_limit then
    insert into bio_ai_requests (instructor_id, mode)
    values (p_instructor_id, p_mode)
    returning id into request_id;
    used := used + 1;
    oldest_at := coalesce(oldest_at, now());
  end if;

  return next;
end;
$$;

revoke all on function public.bio_ai_usage(uuid)
  from public, anon, authenticated;
grant execute on function public.bio_ai_usage(uuid) to service_role;
revoke all on function public.reserve_bio_ai_request(uuid, text, int)
  from public, anon, authenticated;
grant execute on function public.reserve_bio_ai_request(uuid, text, int)
  to service_role;

create or replace function public.update_instructor_profile(
  p_instructor_id uuid,
  p_patch jsonb
) returns void
language plpgsql
as $$
declare
  v_cert   jsonb;
  v_trn    jsonb;
  v_synced boolean := coalesce((p_patch->>'bio_synced')::boolean, false);
begin
  if p_patch is null then
    return;
  end if;

  update instructors set
    display_name_en = case when p_patch ? 'display_name_en'
      then coalesce(p_patch->>'display_name_en', display_name_en)
      else display_name_en end,
    display_name_zh = case when p_patch ? 'display_name_zh'
      then p_patch->>'display_name_zh' else display_name_zh end,
    bio_en = case when p_patch ? 'bio_en'
      then p_patch->>'bio_en' else bio_en end,
    bio_zh = case when p_patch ? 'bio_zh'
      then p_patch->>'bio_zh' else bio_zh end,
    bio_en_machine_translated = case
      when p_patch ? 'bio_en_machine_translated'
        then coalesce((p_patch->>'bio_en_machine_translated')::boolean, false)
      when p_patch ? 'bio_en' then false
      else bio_en_machine_translated end,
    bio_zh_machine_translated = case
      when p_patch ? 'bio_zh_machine_translated'
        then coalesce((p_patch->>'bio_zh_machine_translated')::boolean, false)
      when p_patch ? 'bio_zh' then false
      else bio_zh_machine_translated end,
    bio_en_translated_by = case when p_patch ? 'bio_en_translated_by'
      then p_patch->>'bio_en_translated_by' else bio_en_translated_by end,
    bio_zh_translated_by = case when p_patch ? 'bio_zh_translated_by'
      then p_patch->>'bio_zh_translated_by' else bio_zh_translated_by end,
    bio_en_updated_at = case when v_synced
      then now() else bio_en_updated_at end,
    bio_zh_updated_at = case when v_synced
      then now() else bio_zh_updated_at end,
    date_of_birth = case when p_patch ? 'date_of_birth'
      then (p_patch->>'date_of_birth')::date else date_of_birth end,
    preferred_language = case when p_patch ? 'preferred_language'
      then p_patch->>'preferred_language' else preferred_language end,
    profile_photo_url = case when p_patch ? 'profile_photo_url'
      then p_patch->>'profile_photo_url' else profile_photo_url end,
    min_student_age = case when p_patch ? 'min_student_age'
      then (p_patch->>'min_student_age')::smallint else min_student_age end
  where id = p_instructor_id;

  if not found then
    raise exception 'instructor % not found', p_instructor_id
      using errcode = 'P0001';
  end if;

  if p_patch ? 'teaching_location_ids' then
    delete from instructors_teaching_locations
      where instructor_id = p_instructor_id;
    insert into instructors_teaching_locations (instructor_id, teaching_location_id)
    select p_instructor_id, value::uuid
    from jsonb_array_elements_text(p_patch->'teaching_location_ids');
  end if;

  if p_patch ? 'language_ids' then
    delete from instructors_languages
      where instructor_id = p_instructor_id;
    insert into instructors_languages (instructor_id, language_id)
    select p_instructor_id, value::uuid
    from jsonb_array_elements_text(p_patch->'language_ids');
  end if;

  if p_patch ? 'course_level_offered_ids' then
    delete from instructors_course_levels_offered
      where instructor_id = p_instructor_id;
    insert into instructors_course_levels_offered (instructor_id, course_level_offered_id)
    select p_instructor_id, value::uuid
    from jsonb_array_elements_text(p_patch->'course_level_offered_ids');
  end if;

  if p_patch ? 'certifications' then
    delete from instructor_certifications
      where instructor_id = p_instructor_id;
    for v_cert in
      select * from jsonb_array_elements(p_patch->'certifications')
    loop
      insert into instructor_certifications (
        instructor_id, org, track, level,
        is_partial, partial_components, achieved_on
      ) values (
        p_instructor_id,
        v_cert->>'org',
        v_cert->>'track',
        (v_cert->>'level')::int,
        coalesce((v_cert->>'is_partial')::boolean, false),
        coalesce(
          (select array_agg(c)
             from jsonb_array_elements_text(v_cert->'partial_components') c),
          '{}'::text[]
        ),
        nullif(v_cert->>'achieved_on', '')::date
      );
    end loop;
  end if;

  if p_patch ? 'trainer_status' then
    delete from instructor_trainer_status
      where instructor_id = p_instructor_id;
    for v_trn in
      select * from jsonb_array_elements(p_patch->'trainer_status')
    loop
      insert into instructor_trainer_status (
        instructor_id, discipline, rookie_session_completed,
        trainer_exam_passed, trainer_level
      ) values (
        p_instructor_id,
        v_trn->>'discipline',
        coalesce((v_trn->>'rookie_session_completed')::boolean, false),
        coalesce((v_trn->>'trainer_exam_passed')::boolean, false),
        nullif(v_trn->>'trainer_level', '')::int
      );
    end loop;
  end if;
end;
$$;

comment on function public.update_instructor_profile(uuid, jsonb) is
  'T3.4 transactional profile update: partial core-column patch + relation '
  'replacement in one transaction. Omitted keys untouched; [] clears a relation. '
  'bio_*_machine_translated / bio_*_translated_by override the bio-write reset. '
  'bio_synced = true stamps both bio_*_updated_at with the same now().';

revoke all on function public.update_instructor_profile(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.update_instructor_profile(uuid, jsonb)
  to service_role;
