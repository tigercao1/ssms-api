\set ON_ERROR_STOP on
begin;

insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111291', 'ci-stats-a@example.com'),
  ('11111111-1111-4111-8111-111111111292', 'ci-stats-b@example.com'),
  ('11111111-1111-4111-8111-111111111293', 'ci-stats-c@example.com'),
  ('11111111-1111-4111-8111-111111111294', 'ci-stats-d@example.com');
insert into instructors (id, auth_user_id, email, approval_status, is_active) values
  ('22222222-2222-4222-8222-222222222291', '11111111-1111-4111-8111-111111111291',
   'ci-stats-a@example.com', 'approved', true),
  ('22222222-2222-4222-8222-222222222292', '11111111-1111-4111-8111-111111111292',
   'ci-stats-b@example.com', 'approved', false),
  ('22222222-2222-4222-8222-222222222293', '11111111-1111-4111-8111-111111111293',
   'ci-stats-c@example.com', 'pending', true),
  ('22222222-2222-4222-8222-222222222294', '11111111-1111-4111-8111-111111111294',
   'ci-stats-d@example.com', 'approved', true);
insert into document_templates (id, kind, audience, title_en, status, assign_to, season)
values ('33333333-3333-4333-8333-333333333291', 'read', 'instructor', 'CI stats',
        'live', 'all', '2026/27');
insert into document_assignments (template_id, subject_type, subject_id, season, status) values
  ('33333333-3333-4333-8333-333333333291', 'instructor', '22222222-2222-4222-8222-222222222291', '2026/27', 'completed'),
  ('33333333-3333-4333-8333-333333333291', 'instructor', '22222222-2222-4222-8222-222222222292', '2026/27', 'completed'),
  ('33333333-3333-4333-8333-333333333291', 'instructor', '22222222-2222-4222-8222-222222222293', '2026/27', 'assigned'),
  ('33333333-3333-4333-8333-333333333291', 'instructor', '22222222-2222-4222-8222-222222222294', '2026/27', 'archived'),
  ('33333333-3333-4333-8333-333333333291', 'instructor', '22222222-2222-4222-8222-222222222294', '2025/26', 'viewed');

do $$
declare
  r record;
begin
  select * into strict r
  from public.document_template_stats(array['33333333-3333-4333-8333-333333333291'::uuid]);
  if r.assigned_count <> 3 or r.completed_count <> 2 or not r.has_completed then
    raise exception 'season counts changed: %', r;
  end if;
  if r.approved_assigned_count <> 1 or r.approved_completed_count <> 1 then
    raise exception 'approved active counts wrong: %', r;
  end if;
end;
$$;

rollback;
\echo 'Document template stats checks passed.'
