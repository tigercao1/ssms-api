create or replace function public.revoke_user_sessions(p_user_id uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count int;
begin
  delete from auth.sessions where user_id = p_user_id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.revoke_user_sessions(uuid)
  from public, anon, authenticated;
grant execute on function public.revoke_user_sessions(uuid)
  to service_role;

create or replace function public.session_is_active(p_session_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from auth.sessions
     where id = p_session_id
       and (not_after is null or not_after > now())
  );
$$;

revoke all on function public.session_is_active(uuid)
  from public, anon, authenticated;
grant execute on function public.session_is_active(uuid)
  to service_role;
