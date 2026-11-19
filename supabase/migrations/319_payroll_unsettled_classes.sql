create or replace function public.payroll_unsettled_class_ids()
returns table (class_id uuid)
language sql
stable
set search_path = public
as $$
  with paid as (
    select l.class_id,
           sum(l.amount) as net,
           (array_agg(l.amount order by l.created_at, l.id) filter (
             where not l.flags && array['already_paid', 'late_cancel']
           ))[1] as first_paid
      from payroll_lines l
     where l.kind = 'class'
     group by l.class_id
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
    left join paid on paid.class_id = c.id
   where p.status = 'finalized'
     and c.status <> 'cancelled'
     and (paid.first_paid is null or paid.net <> paid.first_paid);
$$;

revoke all on function public.payroll_unsettled_class_ids()
  from public, anon, authenticated;
grant execute on function public.payroll_unsettled_class_ids()
  to service_role;
