\set ON_ERROR_STOP on
begin;

insert into auth.users (id, email)
values ('11111111-1111-4111-8111-111111111181', 'ci-demoted@example.com'),
       ('11111111-1111-4111-8111-111111111182', 'ci-bystander@example.com');
insert into auth.sessions (id, user_id, not_after)
values ('33333333-3333-4333-8333-333333333181', '11111111-1111-4111-8111-111111111181', null),
       ('33333333-3333-4333-8333-333333333182', '11111111-1111-4111-8111-111111111181', now() + interval '1 hour'),
       ('33333333-3333-4333-8333-333333333183', '11111111-1111-4111-8111-111111111182', null),
       ('33333333-3333-4333-8333-333333333184', '11111111-1111-4111-8111-111111111182', now() - interval '1 minute');

do $$
declare
  target constant uuid := '11111111-1111-4111-8111-111111111181';
  bystander constant uuid := '11111111-1111-4111-8111-111111111182';
begin
  if not public.session_is_active('33333333-3333-4333-8333-333333333181') then
    raise exception 'a session without not_after is not active';
  end if;
  if not public.session_is_active('33333333-3333-4333-8333-333333333182') then
    raise exception 'a session with a future not_after is not active';
  end if;
  if public.session_is_active('33333333-3333-4333-8333-333333333184') then
    raise exception 'an expired session is active';
  end if;
  if public.session_is_active(gen_random_uuid()) then
    raise exception 'an unknown session is active';
  end if;

  if public.revoke_user_sessions(target) <> 2 then
    raise exception 'revoke_user_sessions did not report two revoked sessions';
  end if;
  if exists (select 1 from auth.sessions where user_id = target) then
    raise exception 'the target still has sessions';
  end if;
  if (select count(*) from auth.sessions where user_id = bystander) <> 2 then
    raise exception 'another user''s sessions were revoked';
  end if;
  if public.session_is_active('33333333-3333-4333-8333-333333333181') then
    raise exception 'a revoked session is still active';
  end if;
  if not public.session_is_active('33333333-3333-4333-8333-333333333183') then
    raise exception 'a bystander session stopped being active';
  end if;
  if public.revoke_user_sessions(target) <> 0 then
    raise exception 'a repeat revoke reported revoked sessions';
  end if;
end
$$;

do $$
declare
  f text;
  r text;
begin
  foreach f in array array[
    'public.revoke_user_sessions(uuid)',
    'public.session_is_active(uuid)'
  ] loop
    foreach r in array array['anon', 'authenticated'] loop
      if has_function_privilege(r, f, 'execute') then
        raise exception '% can execute %', r, f;
      end if;
    end loop;
    if not has_function_privilege('service_role', f, 'execute') then
      raise exception 'service_role cannot execute %', f;
    end if;
    if exists (
      select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
       where p.oid = f::regprocedure and a.grantee = 0
    ) then
      raise exception 'PUBLIC can execute %', f;
    end if;
  end loop;
end
$$;

rollback;
\echo 'Session revocation checks passed.'
