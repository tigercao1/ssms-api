alter table instructors
  add column if not exists min_student_age smallint not null default 5;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'instructors_min_student_age_range'
      and conrelid = 'public.instructors'::regclass
  ) then
    alter table instructors
      add constraint instructors_min_student_age_range
      check (min_student_age between 0 and 18);
  end if;
end
$$;
