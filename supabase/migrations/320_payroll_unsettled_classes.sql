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
  with paid as (
    select l.class_id,
           l.instructor_id,
           sum(l.amount) as net,
           (array_agg(
             case
               when l.hourly_rate is null then 0
               when l.rate_unit = 'day' then round(l.hourly_rate, 2)
               else round(round(l.hourly_rate * 100) * coalesce(l.minutes, 0) / 60) / 100
             end
             order by l.created_at, l.id
           ) filter (where not l.flags @> array['already_paid']))[1] as owed
      from payroll_lines l
     where l.kind = 'class'
     group by l.class_id, l.instructor_id
  )
  select c.id
    from classes c
    join paid on paid.class_id = c.id
   where paid.net <> 0
     and (c.status = 'cancelled' or paid.instructor_id <> c.instructor_id)
  union
  select c.id
    from classes c
    join paid
      on paid.class_id = c.id
     and paid.instructor_id = c.instructor_id
   where c.status <> 'cancelled'
     and paid.owed is not null
     and paid.net <> paid.owed
  union
  select c.id
    from payroll_periods p
    join classes c
      on c.starts_at >= (p.starts_on::timestamp at time zone 'America/Toronto')
     and c.starts_at < ((p.ends_on + 1)::timestamp at time zone 'America/Toronto')
   where p.status = 'finalized'
     and c.status <> 'cancelled'
     and not exists (
       select 1
         from paid
        where paid.class_id = c.id
          and paid.instructor_id = c.instructor_id
          and paid.owed is not null
     );
$$;

revoke all on function public.payroll_unsettled_class_ids()
  from public, anon, authenticated;
grant execute on function public.payroll_unsettled_class_ids()
  to service_role;
