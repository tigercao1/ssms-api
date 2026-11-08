create or replace function public.assign_instructor_display_order()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and old.approval_status = 'approved' and old.is_active then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtext('instructors.display_order'));
  select coalesce(max(display_order), 0) + 1
    into new.display_order
    from instructors;
  return new;
end;
$$;

revoke all on function public.assign_instructor_display_order()
  from public, anon, authenticated;

drop trigger if exists instructors_assign_display_order on instructors;
create trigger instructors_assign_display_order
  before insert or update of approval_status, is_active on instructors
  for each row
  when (new.display_order is null
        and new.approval_status = 'approved'
        and new.is_active)
  execute function public.assign_instructor_display_order();
