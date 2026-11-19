alter table classes
  add column if not exists ics_sequence int not null default 0;

create or replace function public.bump_class_ics_sequence()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if (new.starts_at, new.ends_at, new.instructor_id, new.location_id, new.lesson_type_id, new.status)
     is distinct from
     (old.starts_at, old.ends_at, old.instructor_id, old.location_id, old.lesson_type_id, old.status) then
    new.ics_sequence := old.ics_sequence + 1;
  end if;
  return new;
end;
$$;

revoke all on function public.bump_class_ics_sequence()
  from public, anon, authenticated;

create or replace trigger classes_bump_ics_sequence
  before update on classes
  for each row execute function public.bump_class_ics_sequence();
