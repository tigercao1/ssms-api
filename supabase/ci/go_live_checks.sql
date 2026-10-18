\set ON_ERROR_STOP on
\o /dev/null
begin;

insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111301', 'ci-go-live@example.com');
insert into instructors (id, auth_user_id, email, first_name, last_name) values
  ('22222222-2222-4222-8222-222222222301', '11111111-1111-4111-8111-111111111301',
   'ci-go-live@example.com', 'Go', 'Live');
insert into instructor_certifications (instructor_id, org, track, level) values
  ('22222222-2222-4222-8222-222222222301', 'csia', 'regular', 3);
insert into document_templates (id, kind, audience, title_en) values
  ('33333333-3333-4333-8333-333333333301', 'sign', 'instructor', 'CI go-live');

create temp table queued (step text, instructor_id uuid);
create function pg_temp.drain(p_step text) returns void language sql as $$
  insert into queued select p_step, instructor_id from instructor_sync_queue;
  delete from instructor_sync_queue;
$$;

select pg_temp.drain('setup');

insert into certification_uploads
  (id, instructor_id, org, track, file_key, sha256, content_type, size_bytes, valid_until) values
  ('55555555-5555-4555-8555-555555555301', '22222222-2222-4222-8222-222222222301', 'csia',
   'regular', 'k', repeat('a', 64), 'application/pdf', 1, '2027-06-30');
select pg_temp.drain('upload inserted');

update certification_uploads set ai_result = '{}'::jsonb
 where id = '55555555-5555-4555-8555-555555555301';
select pg_temp.drain('upload ai checked');

update certification_uploads set review_status = 'approved', verified_level = 3
 where id = '55555555-5555-4555-8555-555555555301';
select pg_temp.drain('upload approved');

insert into document_assignments (id, template_id, subject_type, subject_id, season) values
  ('44444444-4444-4444-8444-444444444301', '33333333-3333-4333-8333-333333333301', 'instructor',
   '22222222-2222-4222-8222-222222222301', '2026/27'),
  ('44444444-4444-4444-8444-444444444302', '33333333-3333-4333-8333-333333333301', 'customer',
   '22222222-2222-4222-8222-222222222399', '2026/27');
select pg_temp.drain('assignments inserted');

update document_assignments set viewed_at = now(), status = 'viewed'
 where id = '44444444-4444-4444-8444-444444444302';
update document_assignments set viewed_at = now()
 where id = '44444444-4444-4444-8444-444444444301';
select pg_temp.drain('assignments viewed');

update document_assignments set status = 'completed', completed_at = now()
 where id = '44444444-4444-4444-8444-444444444301';
select pg_temp.drain('assignment completed');

delete from certification_uploads where id = '55555555-5555-4555-8555-555555555301';
select pg_temp.drain('upload deleted');

do $$
declare
  expected text[][] := array[
    ['upload inserted', '1'],
    ['upload ai checked', '0'],
    ['upload approved', '1'],
    ['assignments inserted', '1'],
    ['assignments viewed', '0'],
    ['assignment completed', '1'],
    ['upload deleted', '1']
  ];
  got int;
  r text;
  f text := 'public.enqueue_instructor_sync_for_document_subject()';
begin
  for i in 1 .. array_length(expected, 1) loop
    select count(*) into got from queued
     where step = expected[i][1]
       and instructor_id = '22222222-2222-4222-8222-222222222301';
    if got <> expected[i][2]::int then
      raise exception 'step "%": expected % queued instructor row(s), got %',
        expected[i][1], expected[i][2], got;
    end if;
  end loop;
  if exists (select 1 from queued where instructor_id = '22222222-2222-4222-8222-222222222399') then
    raise exception 'a non-instructor document subject was queued';
  end if;
  foreach r in array array['anon', 'authenticated'] loop
    if has_function_privilege(r, f, 'execute') then
      raise exception '% can execute %', r, f;
    end if;
  end loop;
end
$$;

rollback;
\echo 'Go-live checks passed.'
