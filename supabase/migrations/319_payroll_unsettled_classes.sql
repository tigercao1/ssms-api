create unique index if not exists payroll_lines_period_class_instructor_key
  on payroll_lines (period_id, class_id, instructor_id)
  where class_id is not null;
drop index if exists payroll_lines_period_class_key;

create or replace function public.payroll_unsettled_class_ids()
returns table (class_id uuid)
language sql
stable
set search_path = public
as $$
  with lines as (
    select l.class_id,
           l.instructor_id,
           l.amount,
           l.flags,
           l.created_at,
           l.id,
           sum(l.amount) over (
             partition by l.class_id, l.instructor_id
             order by l.created_at, l.id
           ) as running
      from payroll_lines l
     where l.kind = 'class'
  ),
  paid as (
    select lines.class_id,
           lines.instructor_id,
           sum(lines.amount) as net,
           (array_agg(lines.running order by lines.created_at, lines.id) filter (
             where not lines.flags && array['already_paid', 'late_cancel']
           ))[1] as owed
      from lines
     group by lines.class_id, lines.instructor_id
  )
  select c.id
    from classes c
    join paid on paid.class_id = c.id
   where c.status = 'cancelled'
     and paid.net <> 0
  union
  select c.id
    from payroll_periods p
    join classes c
      on c.starts_at >= (p.starts_on::timestamp at time zone 'America/Toronto')
     and c.starts_at < ((p.ends_on + 1)::timestamp at time zone 'America/Toronto')
    left join paid
      on paid.class_id = c.id
     and paid.instructor_id = c.instructor_id
   where p.status = 'finalized'
     and c.status <> 'cancelled'
     and (
       paid.owed is null
       or paid.net <> paid.owed
       or exists (
         select 1
           from paid other
          where other.class_id = c.id
            and other.instructor_id <> c.instructor_id
            and other.net <> 0
       )
     );
$$;

revoke all on function public.payroll_unsettled_class_ids()
  from public, anon, authenticated;
grant execute on function public.payroll_unsettled_class_ids()
  to service_role;
