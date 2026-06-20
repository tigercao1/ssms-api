-- T3.4 — Transactional instructor profile update RPC.
--
-- Applies a partial JSONB patch to an instructor in a SINGLE transaction:
--   * updates only the core columns whose keys are present in the patch
--   * replaces relation rows (teaching locations / languages / course levels /
--     certifications / trainer status) when (and only when) the patch carries
--     that key
--
-- Semantics (CREATE_INSTRUCTOR_EXAMPLE.md § Notes):
--   * key omitted        -> field/relation left untouched
--   * key present         -> applied (JSON null clears a scalar)
--   * relation = []       -> clears that relation
--
-- Because a PL/pgSQL function body runs inside the caller's transaction, ANY
-- error (CHECK / UNIQUE / FK violation, or a mid-update failure) rolls back the
-- whole change — partial writes are impossible (T3.4 acceptance).
--
-- Called by NestJS via PostgREST RPC with the service-role key
-- (InstructorsRepository.applyProfilePatch).

create or replace function public.update_instructor_profile(
  p_instructor_id uuid,
  p_patch jsonb
) returns void
language plpgsql
as $$
declare
  v_cert  jsonb;
  v_trn   jsonb;
begin
  if p_patch is null then
    return;
  end if;

  -- ---- Core columns (only those present in the patch) -----------------------
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
    -- A human edit of a bio clears its machine-translated flag
    -- (INSTRUCTOR_PROFILE_FIELDS.md: "cleared on human edit").
    bio_en_machine_translated = case when p_patch ? 'bio_en'
      then false else bio_en_machine_translated end,
    bio_zh_machine_translated = case when p_patch ? 'bio_zh'
      then false else bio_zh_machine_translated end,
    date_of_birth = case when p_patch ? 'date_of_birth'
      then (p_patch->>'date_of_birth')::date else date_of_birth end,
    preferred_language = case when p_patch ? 'preferred_language'
      then p_patch->>'preferred_language' else preferred_language end,
    profile_photo_url = case when p_patch ? 'profile_photo_url'
      then p_patch->>'profile_photo_url' else profile_photo_url end
  where id = p_instructor_id;

  if not found then
    raise exception 'instructor % not found', p_instructor_id
      using errcode = 'P0001';
  end if;

  -- ---- Teaching locations ---------------------------------------------------
  if p_patch ? 'teaching_location_ids' then
    delete from instructors_teaching_locations
      where instructor_id = p_instructor_id;
    insert into instructors_teaching_locations (instructor_id, teaching_location_id)
    select p_instructor_id, value::uuid
    from jsonb_array_elements_text(p_patch->'teaching_location_ids');
  end if;

  -- ---- Languages ------------------------------------------------------------
  if p_patch ? 'language_ids' then
    delete from instructors_languages
      where instructor_id = p_instructor_id;
    insert into instructors_languages (instructor_id, language_id)
    select p_instructor_id, value::uuid
    from jsonb_array_elements_text(p_patch->'language_ids');
  end if;

  -- ---- Course levels offered ------------------------------------------------
  if p_patch ? 'course_level_offered_ids' then
    delete from instructors_course_levels_offered
      where instructor_id = p_instructor_id;
    insert into instructors_course_levels_offered (instructor_id, course_level_offered_id)
    select p_instructor_id, value::uuid
    from jsonb_array_elements_text(p_patch->'course_level_offered_ids');
  end if;

  -- ---- Certifications (full replacement) ------------------------------------
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

  -- ---- Trainer status (full replacement) ------------------------------------
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
  'replacement in one transaction. Omitted keys untouched; [] clears a relation.';

-- Service-role (NestJS) path only; never exposed to anon/authenticated.
revoke all on function public.update_instructor_profile(uuid, jsonb)
  from anon, authenticated;
