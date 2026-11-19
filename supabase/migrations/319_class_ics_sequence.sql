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

create or replace function public.bump_class_ics_sequence_on_participants()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    update classes c
       set ics_sequence = c.ics_sequence + 1
     where c.id in (select class_id from changed_participants)
       and c.created_at < now();
  else
    update classes c
       set ics_sequence = c.ics_sequence + 1
     where c.id in (select class_id from changed_participants);
  end if;
  return null;
end;
$$;

revoke all on function public.bump_class_ics_sequence_on_participants()
  from public, anon, authenticated;

create or replace trigger class_participants_added_bump_ics_sequence
  after insert on class_participants
  referencing new table as changed_participants
  for each statement execute function public.bump_class_ics_sequence_on_participants();

create or replace trigger class_participants_removed_bump_ics_sequence
  after delete on class_participants
  referencing old table as changed_participants
  for each statement execute function public.bump_class_ics_sequence_on_participants();
