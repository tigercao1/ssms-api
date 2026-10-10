revoke all on function public.update_instructor_profile(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.update_instructor_profile(uuid, jsonb)
  to service_role;

drop trigger if exists teaching_locations_enqueue_sync on teaching_locations;
create trigger teaching_locations_enqueue_sync
  after update on teaching_locations
  for each row
  when (old.name is distinct from new.name
        or old.name_zh is distinct from new.name_zh
        or old.is_active is distinct from new.is_active)
  execute function public.enqueue_instructor_sync_for_reference(
    'instructors_teaching_locations', 'teaching_location_id');

drop trigger if exists languages_enqueue_sync on languages;
create trigger languages_enqueue_sync
  after update on languages
  for each row
  when (old.name is distinct from new.name
        or old.name_zh is distinct from new.name_zh
        or old.is_active is distinct from new.is_active)
  execute function public.enqueue_instructor_sync_for_reference(
    'instructors_languages', 'language_id');

drop trigger if exists course_levels_offered_enqueue_sync on course_levels_offered;
create trigger course_levels_offered_enqueue_sync
  after update on course_levels_offered
  for each row
  when (old.name is distinct from new.name
        or old.name_zh is distinct from new.name_zh
        or old.is_active is distinct from new.is_active)
  execute function public.enqueue_instructor_sync_for_reference(
    'instructors_course_levels_offered', 'course_level_offered_id');

drop trigger if exists exam_preparations_enqueue_sync on exam_preparations;
create trigger exam_preparations_enqueue_sync
  after update on exam_preparations
  for each row
  when (old.name is distinct from new.name
        or old.name_zh is distinct from new.name_zh
        or old.is_active is distinct from new.is_active)
  execute function public.enqueue_instructor_sync_for_reference(
    'instructors_exam_preparations', 'exam_preparation_id');

alter table instructor_trainer_status
  drop constraint if exists trainer_level_requires_rookie;

alter table instructors add column if not exists display_order integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'instructors_display_order_nonnegative'
       and conrelid = 'public.instructors'::regclass
  ) then
    alter table instructors
      add constraint instructors_display_order_nonnegative
      check (display_order >= 0);
  end if;
end
$$;
