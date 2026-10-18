\set ON_ERROR_STOP on
begin;

do $$
declare
  v_hash text := repeat('a', 64);
  v_other text := repeat('b', 64);
  v_claim record;
begin
  if activation_resend_retry_after(v_hash, 60) <> 0 then
    raise exception 'an email that never asked has a cooldown';
  end if;

  select * into v_claim from claim_activation_resend(v_hash, 60);
  if not v_claim.accepted or v_claim.retry_after_seconds <> 60 then
    raise exception 'the first request was not accepted with a full cooldown: %', v_claim;
  end if;
  if activation_resend_retry_after(v_hash, 60) <> 60 then
    raise exception 'the cooldown was not running right after an accepted request';
  end if;

  update activation_resend_cooldowns
     set last_requested_at = now() - interval '20.5 seconds'
   where email_hash = v_hash;
  select * into v_claim from claim_activation_resend(v_hash, 60);
  if v_claim.accepted or v_claim.retry_after_seconds <> 40 then
    raise exception 'a request inside the window was not refused with the remaining seconds: %', v_claim;
  end if;
  if activation_resend_retry_after(v_hash, 60) <> 40 then
    raise exception 'a refused request moved the window';
  end if;

  select * into v_claim from claim_activation_resend(v_other, 60);
  if not v_claim.accepted then
    raise exception 'one email''s cooldown blocked another email';
  end if;

  update activation_resend_cooldowns
     set last_requested_at = now() - interval '60 seconds'
   where email_hash = v_hash;
  select * into v_claim from claim_activation_resend(v_hash, 60);
  if not v_claim.accepted or v_claim.retry_after_seconds <> 60 then
    raise exception 'a request after the window was not accepted: %', v_claim;
  end if;

  begin
    perform claim_activation_resend('jane@example.test', 60);
    raise exception 'a plaintext email was stored';
  exception when check_violation then null;
  end;
end
$$;

do $$
declare
  f text;
  r text;
begin
  if not exists (
    select 1 from pg_class
     where oid = 'public.activation_resend_cooldowns'::regclass
       and relrowsecurity and relforcerowsecurity
  ) then
    raise exception 'activation_resend_cooldowns does not have forced row level security';
  end if;
  foreach r in array array['anon', 'authenticated'] loop
    if has_table_privilege(r, 'public.activation_resend_cooldowns', 'select, insert, update, delete') then
      raise exception '% has privileges on activation_resend_cooldowns', r;
    end if;
  end loop;
  foreach f in array array[
    'public.claim_activation_resend(text, int)',
    'public.activation_resend_retry_after(text, int)'
  ] loop
    foreach r in array array['anon', 'authenticated'] loop
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
  end loop;
end
$$;

rollback;
\echo 'Activation resend cooldown checks passed.'
