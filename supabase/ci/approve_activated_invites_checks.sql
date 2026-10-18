\set ON_ERROR_STOP on
\o /dev/null
begin;

insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111401', 'ci-invite-1@example.com'),
  ('11111111-1111-4111-8111-111111111402', 'ci-invite-2@example.com'),
  ('11111111-1111-4111-8111-111111111403', 'ci-invite-3@example.com'),
  ('11111111-1111-4111-8111-111111111404', 'ci-invite-4@example.com'),
  ('11111111-1111-4111-8111-111111111405', 'ci-invite-5@example.com'),
  ('11111111-1111-4111-8111-111111111406', 'ci-invite-6@example.com');
insert into instructors (id, auth_user_id, email, approval_status, is_active) values
  ('22222222-2222-4222-8222-222222222401', '11111111-1111-4111-8111-111111111401',
   'ci-invite-1@example.com', 'pending', true),
  ('22222222-2222-4222-8222-222222222402', '11111111-1111-4111-8111-111111111402',
   'ci-invite-2@example.com', 'pending', true),
  ('22222222-2222-4222-8222-222222222403', '11111111-1111-4111-8111-111111111403',
   'ci-invite-3@example.com', 'rejected', true),
  ('22222222-2222-4222-8222-222222222404', '11111111-1111-4111-8111-111111111404',
   'ci-invite-4@example.com', 'pending', false),
  ('22222222-2222-4222-8222-222222222405', '11111111-1111-4111-8111-111111111405',
   'ci-invite-5@example.com', 'pending', true),
  ('22222222-2222-4222-8222-222222222406', '11111111-1111-4111-8111-111111111406',
   'ci-invite-6@example.com', 'pending', true);
insert into seasons (key, starts_on, ends_on) values
  ('2019/20', '2019-11-01', '2020-04-30');
insert into instructor_invites (instructor_id, auth_user_id, email, season, activated_at, created_at) values
  ('22222222-2222-4222-8222-222222222401', '11111111-1111-4111-8111-111111111401',
   'ci-invite-1@example.com', '2026/27', now(), now()),
  ('22222222-2222-4222-8222-222222222402', '11111111-1111-4111-8111-111111111402',
   'ci-invite-2@example.com', '2026/27', null, now()),
  ('22222222-2222-4222-8222-222222222403', '11111111-1111-4111-8111-111111111403',
   'ci-invite-3@example.com', '2026/27', now(), now()),
  ('22222222-2222-4222-8222-222222222404', '11111111-1111-4111-8111-111111111404',
   'ci-invite-4@example.com', '2026/27', now(), now()),
  ('22222222-2222-4222-8222-222222222406', '11111111-1111-4111-8111-111111111406',
   'ci-invite-6@example.com', '2019/20', now(), now() - interval '1 year'),
  ('22222222-2222-4222-8222-222222222406', '11111111-1111-4111-8111-111111111406',
   'ci-invite-6@example.com', '2026/27', null, now());

\ir ../migrations/306_approve_activated_invites.sql
\ir ../migrations/306_approve_activated_invites.sql

do $$
declare
  expected text[][] := array[
    ['22222222-2222-4222-8222-222222222401', 'approved', '1'],
    ['22222222-2222-4222-8222-222222222402', 'pending', '0'],
    ['22222222-2222-4222-8222-222222222403', 'rejected', '0'],
    ['22222222-2222-4222-8222-222222222404', 'pending', '0'],
    ['22222222-2222-4222-8222-222222222405', 'pending', '0'],
    ['22222222-2222-4222-8222-222222222406', 'pending', '0']
  ];
  got_status text;
  got_audits int;
begin
  for i in 1 .. array_length(expected, 1) loop
    select approval_status into got_status from instructors
     where id = expected[i][1]::uuid;
    select count(*) into got_audits from audit_log
     where target_id = expected[i][1]::uuid
       and action = 'instructor.approve'
       and actor_role = 'system'
       and metadata ->> 'source' = 'invite_activation_backfill';
    if got_status <> expected[i][2] or got_audits <> expected[i][3]::int then
      raise exception 'instructor %: expected % with % audit row(s), got % with %',
        expected[i][1], expected[i][2], expected[i][3], got_status, got_audits;
    end if;
  end loop;
end
$$;

rollback;
\echo 'Approve activated invites checks passed.'
