-- T2.5 email-sync trigger. Source of truth is auth.users.email; the mirrored
-- instructors.email column is for query convenience (DATA_MODEL.md § Email sync).
--
-- On auth.users INSERT no instructors row exists yet (created lazily on first
-- GET /me/instructor), so the UPDATE is a no-op then. On email change it
-- propagates to the existing profile row.

create or replace function public.sync_instructor_email()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update instructors
     set email = new.email
   where auth_user_id = new.id
     and email is distinct from new.email;
  return new;
end;
$$;

create trigger sync_instructor_email_on_auth_users
  after insert or update of email on auth.users
  for each row execute function public.sync_instructor_email();
