\set ON_ERROR_STOP on
begin;

insert into auth.users (id, email)
values ('11111111-1111-4111-8111-111111111192', 'ci-seasons@example.com');
insert into instructors (id, auth_user_id, email, display_name_en)
values ('22222222-2222-4222-8222-222222222292', '11111111-1111-4111-8111-111111111192', 'ci-seasons@example.com', 'CI Seasons');

do $$
declare
  i constant uuid := '22222222-2222-4222-8222-222222222292';
  u constant uuid := '11111111-1111-4111-8111-111111111192';
  t uuid;
begin
  if not exists (
    select 1 from seasons
     where key = '2026/27' and starts_on = date '2026-11-01' and ends_on = date '2027-04-30'
  ) then
    raise exception 'season 2026/27 is not seeded';
  end if;

  begin
    insert into seasons (key, starts_on, ends_on) values ('2027-28', '2027-11-01', '2028-04-30');
    raise exception 'a malformed season key was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into seasons (key, starts_on, ends_on) values ('2027/28', '2027-11-01', '2027-11-01');
    raise exception 'a season ending on its start was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into seasons (key, starts_on, ends_on) values ('2027/28', '2027-04-30', '2028-04-30');
    raise exception 'an overlapping season was accepted';
  exception when exclusion_violation then null;
  end;
  insert into seasons (key, starts_on, ends_on) values ('2027/28', '2027-05-01', '2028-04-30');

  begin
    insert into instructor_invites (instructor_id, auth_user_id, email, season, expires_at)
    values (i, u, 'ci-seasons@example.com', '2099/00', now());
    raise exception 'an invite with an unknown season was accepted';
  exception when foreign_key_violation then null;
  end;
  insert into instructor_invites (instructor_id, auth_user_id, email, season, expires_at)
  values (i, u, 'ci-seasons@example.com', '2027/28', now());

  insert into document_templates (kind, audience, title_en, status, assign_to, season)
  values ('read', 'instructor', 'CI Seasons', 'live', 'all', '2027/28')
  returning id into t;
  begin
    update document_templates set season = '2099/00' where id = t;
    raise exception 'a template with an unknown season was accepted';
  exception when foreign_key_violation then null;
  end;
  begin
    insert into document_assignments (template_id, subject_type, subject_id, season)
    values (t, 'instructor', i, '2099/00');
    raise exception 'an assignment with an unknown season was accepted';
  exception when foreign_key_violation then null;
  end;

  update seasons set key = '2027/29' where key = '2027/28';
  if (select season from instructor_invites where instructor_id = i) <> '2027/29'
     or (select season from document_templates where id = t) <> '2027/29' then
    raise exception 'a season key change did not cascade';
  end if;

  begin
    delete from seasons where key = '2027/29';
    raise exception 'a referenced season was deleted';
  exception when foreign_key_violation then null;
  end;

  if not (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.seasons'::regclass) then
    raise exception 'seasons does not have forced row level security';
  end if;
  if has_table_privilege('anon', 'public.seasons', 'select, insert, update, delete')
     or has_table_privilege('authenticated', 'public.seasons', 'select, insert, update, delete') then
    raise exception 'anon or authenticated has privileges on seasons';
  end if;
end
$$;

rollback;
\echo 'Seasons checks passed.'
