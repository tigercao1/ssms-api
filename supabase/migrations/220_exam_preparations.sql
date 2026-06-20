-- T4.2 (Reference-data, 22x prefix): add the `exam_preparations` reference
-- table + instructor junction. The other three reference tables
-- (teaching_locations, languages, course_levels_offered) were created in
-- 002_reference_and_junctions.sql; exam_preparations follows the identical
-- pattern. See REFERENCE_DATA_BEST_PRACTICES.md and CERTIFICATION_STRUCTURE.md.
--
-- NOTE: CSIA/CASI certifications are NOT reference data in v1 — they are
-- per-instructor records in `instructor_certifications` (see 010/013 +
-- CERTIFICATION_STRUCTURE.md). The retired csia/casi reference tables are not
-- recreated here; only locations/languages/levels/exam-preps are seeded.

create table if not exists exam_preparations (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique,
  name        text not null,
  sort_order  int not null default 0,
  is_active   boolean not null default true
);

-- Many-to-many junction. Composite PK, cascade from instructors — same shape
-- as the junctions in 002_reference_and_junctions.sql.
create table if not exists instructors_exam_preparations (
  instructor_id        uuid not null references instructors (id) on delete cascade,
  exam_preparation_id  uuid not null references exam_preparations (id) on delete cascade,
  primary key (instructor_id, exam_preparation_id)
);

-- ── Grants: mirror the baseline established in 016_rls_policies.sql ──
grant select on exam_preparations to anon, authenticated;
grant select on instructors_exam_preparations to anon, authenticated;
grant insert, update, delete on instructors_exam_preparations to authenticated;

-- ── RLS: reference table = public read of active rows; admin-only writes ──
alter table exam_preparations enable row level security;
alter table exam_preparations force row level security;
create policy ep_public_read on exam_preparations
  for select to anon, authenticated
  using (is_active = true or public.jwt_is_admin());
create policy ep_admin_write on exam_preparations
  for all to authenticated
  using (public.jwt_is_admin()) with check (public.jwt_is_admin());

-- ── RLS: junction read follows parent visibility; write owner-or-admin ──
alter table instructors_exam_preparations enable row level security;
alter table instructors_exam_preparations force row level security;

create policy iep_read on instructors_exam_preparations
  for select to anon, authenticated
  using (exists (
    select 1 from instructors i
    where i.id = instructor_id
      and ((i.approval_status = 'approved' and i.is_active = true)
           or i.auth_user_id = auth.uid()
           or public.jwt_is_admin())
  ));

create policy iep_write on instructors_exam_preparations
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
