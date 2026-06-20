-- T2.11 RLS policies. Full design + rationale: RLS_AND_SECURITY_PLAN.md.
--
-- Posture: NestJS uses the service-role key (BYPASSRLS), so RLS is OFF the hot
-- path and adds zero read latency. These policies are defense-in-depth for any
-- future direct anon/authenticated access. Deny-by-default; open only the
-- minimum (public read of approved+active instructors, active reference rows).
--
-- api_keys RLS is applied in its own migration (public-api agent, 25x prefix),
-- since the table is created there.

-- ── Admin check from the signed JWT (app_metadata.role is server-set only) ──
create or replace function public.jwt_is_admin()
returns boolean
language sql
stable
as $$
  select coalesce(
    (current_setting('request.jwt.claims', true)::jsonb
       -> 'app_metadata' ->> 'role') = 'admin',
    false
  );
$$;

-- ── Grants: lock the baseline, then re-grant the minimum ──
revoke all on all tables in schema public from anon, authenticated;

grant select on
  instructors,
  instructors_teaching_locations,
  instructors_languages,
  instructors_course_levels_offered,
  instructor_certifications,
  instructor_trainer_status,
  teaching_locations,
  languages,
  course_levels_offered
to anon, authenticated;

grant insert, update, delete on
  instructors,
  instructors_teaching_locations,
  instructors_languages,
  instructors_course_levels_offered,
  instructor_certifications,
  instructor_trainer_status
to authenticated;

-- audit_log + (future) api_keys: no anon/authenticated grants → service_role only.

-- ── instructors ──
alter table instructors enable row level security;
alter table instructors force row level security;

create policy instructors_public_read on instructors
  for select to anon, authenticated
  using (approval_status = 'approved' and is_active = true);

create policy instructors_owner_read on instructors
  for select to authenticated
  using (auth.uid() = auth_user_id);

create policy instructors_admin_read on instructors
  for select to authenticated
  using (public.jwt_is_admin());

create policy instructors_owner_insert on instructors
  for insert to authenticated
  with check (auth.uid() = auth_user_id);

create policy instructors_owner_update on instructors
  for update to authenticated
  using (auth.uid() = auth_user_id)
  with check (auth.uid() = auth_user_id);

create policy instructors_admin_update on instructors
  for update to authenticated
  using (public.jwt_is_admin())
  with check (public.jwt_is_admin());
-- No DELETE policy → deletes denied for anon/authenticated (service_role only).

-- ── Junction tables: read follows parent visibility; write owner-or-admin ──
-- instructors_teaching_locations
alter table instructors_teaching_locations enable row level security;
alter table instructors_teaching_locations force row level security;

create policy itl_read on instructors_teaching_locations
  for select to anon, authenticated
  using (exists (
    select 1 from instructors i
    where i.id = instructor_id
      and ((i.approval_status = 'approved' and i.is_active = true)
           or i.auth_user_id = auth.uid()
           or public.jwt_is_admin())
  ));

create policy itl_write on instructors_teaching_locations
  for all to authenticated
  using (exists (
    select 1 from instructors i
    where i.id = instructor_id
      and (i.auth_user_id = auth.uid() or public.jwt_is_admin())
  ))
  with check (exists (
    select 1 from instructors i
    where i.id = instructor_id
      and (i.auth_user_id = auth.uid() or public.jwt_is_admin())
  ));

-- instructors_languages
alter table instructors_languages enable row level security;
alter table instructors_languages force row level security;

create policy il_read on instructors_languages
  for select to anon, authenticated
  using (exists (
    select 1 from instructors i
    where i.id = instructor_id
      and ((i.approval_status = 'approved' and i.is_active = true)
           or i.auth_user_id = auth.uid()
           or public.jwt_is_admin())
  ));

create policy il_write on instructors_languages
  for all to authenticated
  using (exists (
    select 1 from instructors i
    where i.id = instructor_id
      and (i.auth_user_id = auth.uid() or public.jwt_is_admin())
  ))
  with check (exists (
    select 1 from instructors i
    where i.id = instructor_id
      and (i.auth_user_id = auth.uid() or public.jwt_is_admin())
  ));

-- instructors_course_levels_offered
alter table instructors_course_levels_offered enable row level security;
alter table instructors_course_levels_offered force row level security;

create policy iclo_read on instructors_course_levels_offered
  for select to anon, authenticated
  using (exists (
    select 1 from instructors i
    where i.id = instructor_id
      and ((i.approval_status = 'approved' and i.is_active = true)
           or i.auth_user_id = auth.uid()
           or public.jwt_is_admin())
  ));

create policy iclo_write on instructors_course_levels_offered
  for all to authenticated
  using (exists (
    select 1 from instructors i
    where i.id = instructor_id
      and (i.auth_user_id = auth.uid() or public.jwt_is_admin())
  ))
  with check (exists (
    select 1 from instructors i
    where i.id = instructor_id
      and (i.auth_user_id = auth.uid() or public.jwt_is_admin())
  ));

-- ── instructor_certifications: same shape as junctions ──
alter table instructor_certifications enable row level security;
alter table instructor_certifications force row level security;

create policy itc_read on instructor_certifications
  for select to anon, authenticated
  using (exists (
    select 1 from instructors i
    where i.id = instructor_id
      and ((i.approval_status = 'approved' and i.is_active = true)
           or i.auth_user_id = auth.uid()
           or public.jwt_is_admin())
  ));

create policy itc_write on instructor_certifications
  for all to authenticated
  using (exists (
    select 1 from instructors i
    where i.id = instructor_id
      and (i.auth_user_id = auth.uid() or public.jwt_is_admin())
  ))
  with check (exists (
    select 1 from instructors i
    where i.id = instructor_id
      and (i.auth_user_id = auth.uid() or public.jwt_is_admin())
  ));

-- ── instructor_trainer_status: same shape ──
alter table instructor_trainer_status enable row level security;
alter table instructor_trainer_status force row level security;

create policy its_read on instructor_trainer_status
  for select to anon, authenticated
  using (exists (
    select 1 from instructors i
    where i.id = instructor_id
      and ((i.approval_status = 'approved' and i.is_active = true)
           or i.auth_user_id = auth.uid()
           or public.jwt_is_admin())
  ));

create policy its_write on instructor_trainer_status
  for all to authenticated
  using (exists (
    select 1 from instructors i
    where i.id = instructor_id
      and (i.auth_user_id = auth.uid() or public.jwt_is_admin())
  ))
  with check (exists (
    select 1 from instructors i
    where i.id = instructor_id
      and (i.auth_user_id = auth.uid() or public.jwt_is_admin())
  ));

-- ── Reference tables: public read of active rows; admin-only writes ──
alter table teaching_locations enable row level security;
alter table teaching_locations force row level security;
create policy tl_public_read on teaching_locations
  for select to anon, authenticated
  using (is_active = true or public.jwt_is_admin());
create policy tl_admin_write on teaching_locations
  for all to authenticated
  using (public.jwt_is_admin()) with check (public.jwt_is_admin());

alter table languages enable row level security;
alter table languages force row level security;
create policy lang_public_read on languages
  for select to anon, authenticated
  using (is_active = true or public.jwt_is_admin());
create policy lang_admin_write on languages
  for all to authenticated
  using (public.jwt_is_admin()) with check (public.jwt_is_admin());

alter table course_levels_offered enable row level security;
alter table course_levels_offered force row level security;
create policy clo_public_read on course_levels_offered
  for select to anon, authenticated
  using (is_active = true or public.jwt_is_admin());
create policy clo_admin_write on course_levels_offered
  for all to authenticated
  using (public.jwt_is_admin()) with check (public.jwt_is_admin());

-- ── audit_log: append-only. No policies for anon/authenticated → all denied.
-- service_role bypasses RLS and is the only writer.
alter table audit_log enable row level security;
alter table audit_log force row level security;
