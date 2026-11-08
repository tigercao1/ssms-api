\set ON_ERROR_STOP on
begin;
set local time zone 'UTC';

insert into auth.users (id, email)
values ('11111111-1111-4111-8111-111111111313', 'ci-token-owner@example.com'),
       ('11111111-1111-4111-8111-111111111314', 'ci-token-other@example.com');

insert into admin_api_tokens (id, owner_user_id, name, token_hash, token_prefix, token_last4, created_at, expires_at)
values ('22222222-2222-4222-8222-222222222313', '11111111-1111-4111-8111-111111111313', 'laptop',
        repeat('a', 64), 'ssms_pat_abcd', 'wxyz', now() - interval '10 days', now() + interval '80 days'),
       ('22222222-2222-4222-8222-222222222314', '11111111-1111-4111-8111-111111111313', 'forever',
        repeat('b', 64), 'ssms_pat_efgh', 'stuv', now(), null),
       ('22222222-2222-4222-8222-222222222315', '11111111-1111-4111-8111-111111111313', 'old',
        repeat('c', 64), 'ssms_pat_ijkl', 'opqr', now() - interval '2 days', now() - interval '1 day');

do $$
declare
  owner constant uuid := '11111111-1111-4111-8111-111111111313';
  other constant uuid := '11111111-1111-4111-8111-111111111314';
  v_new record;
  v_old admin_api_tokens;
  v_count int;
begin
  select count(*) into v_count
    from rotate_admin_api_token('22222222-2222-4222-8222-222222222313', other,
                                repeat('d', 64), 'ssms_pat_mnop', 'klmn', true, null, 10);
  if v_count <> 0 then
    raise exception 'another user rotated a token they do not own';
  end if;

  select count(*) into v_count
    from rotate_admin_api_token('22222222-2222-4222-8222-222222222315', owner,
                                repeat('d', 64), 'ssms_pat_mnop', 'klmn', true, null, 10);
  if v_count <> 0 then
    raise exception 'an expired token was rotated';
  end if;

  select * into v_new
    from rotate_admin_api_token('22222222-2222-4222-8222-222222222313', owner,
                                repeat('d', 64), 'ssms_pat_mnop', 'klmn', true, null, 10);
  if v_new.id is null or v_new.name <> 'laptop' or v_new.owner_user_id <> owner then
    raise exception 'rotation did not return the new token: %', v_new;
  end if;
  if abs(extract(epoch from v_new.expires_at - (now() + interval '90 days'))) > 1 then
    raise exception 'rotation did not keep the 90 day expiry setting: %', v_new.expires_at;
  end if;

  select * into v_old from admin_api_tokens where id = '22222222-2222-4222-8222-222222222313';
  if v_old.replaced_by <> v_new.id
     or abs(extract(epoch from v_old.grace_until - (now() + interval '10 minutes'))) > 1 then
    raise exception 'the old token was not put into a 10 minute grace: %', v_old;
  end if;

  select count(*) into v_count
    from rotate_admin_api_token('22222222-2222-4222-8222-222222222313', owner,
                                repeat('e', 64), 'ssms_pat_qrst', 'ghij', true, null, 10);
  if v_count <> 0 then
    raise exception 'a token already rotated was rotated again';
  end if;

  select * into v_new
    from rotate_admin_api_token('22222222-2222-4222-8222-222222222314', owner,
                                repeat('f', 64), 'ssms_pat_uvwx', 'cdef', true, null, 0);
  if v_new.expires_at is not null then
    raise exception 'rotating a never-expiring token gave it an expiry';
  end if;

  select * into v_new
    from rotate_admin_api_token(v_new.id, owner,
                                repeat('0', 64), 'ssms_pat_yzab', 'abcd', false,
                                now() + interval '30 days', 0);
  if v_new.expires_at is null then
    raise exception 'an explicit expiry on rotation was ignored';
  end if;

  begin
    perform rotate_admin_api_token(v_new.id, owner, repeat('1', 64), 'ssms_pat_cdef', 'efgh', true, null, 1441);
    raise exception 'a grace above 24 hours was accepted';
  exception when invalid_parameter_value then null;
  end;

  begin
    insert into admin_api_tokens (owner_user_id, name, token_hash, token_prefix, token_last4)
    values (owner, 'plain', 'ssms_pat_secret', 'ssms_pat_abcd', 'wxyz');
    raise exception 'a token was stored without hashing';
  exception when check_violation then null;
  end;

  begin
    insert into admin_api_tokens (owner_user_id, name, token_hash, token_prefix, token_last4)
    values (owner, 'dup', repeat('a', 64), 'ssms_pat_abcd', 'wxyz');
    raise exception 'two tokens share a hash';
  exception when unique_violation then null;
  end;
end
$$;

do $$
declare
  f constant text := 'public.rotate_admin_api_token(uuid, uuid, text, text, text, boolean, timestamptz, int)';
  r text;
begin
  if not exists (
    select 1 from pg_class
     where oid = 'public.admin_api_tokens'::regclass
       and relrowsecurity and relforcerowsecurity
  ) then
    raise exception 'admin_api_tokens does not have forced row level security';
  end if;
  if exists (select 1 from pg_policies where tablename = 'admin_api_tokens') then
    raise exception 'admin_api_tokens has a row level security policy';
  end if;
  foreach r in array array['anon', 'authenticated'] loop
    if has_table_privilege(r, 'public.admin_api_tokens', 'select, insert, update, delete') then
      raise exception '% has privileges on admin_api_tokens', r;
    end if;
    if has_function_privilege(r, f, 'execute') then
      raise exception '% can execute %', r, f;
    end if;
  end loop;
  if exists (
    select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
     where p.oid = f::regprocedure and a.grantee = 0
  ) then
    raise exception 'PUBLIC can execute %', f;
  end if;
  if not has_function_privilege('service_role', f, 'execute') then
    raise exception 'service_role cannot execute %', f;
  end if;
end
$$;

rollback;
\echo 'Admin API token checks passed.'
