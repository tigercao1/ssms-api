-- Foundation: extensions + shared helpers.
create extension if not exists pgcrypto;  -- gen_random_uuid()

-- Generic updated_at maintainer, reused by tables below.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
