alter table payroll_lines
  drop constraint if exists payroll_lines_minutes_check;
alter table payroll_lines
  add constraint payroll_lines_minutes_check
  check (minutes >= 0 or flags @> array['adjusted']);

create unique index if not exists payroll_lines_period_class_instructor_currency_key
  on payroll_lines (period_id, class_id, instructor_id, currency)
  where class_id is not null;
drop index if exists payroll_lines_period_class_instructor_key;

create or replace function public.payroll_unsettled_class_ids()
returns table (class_id uuid)
language sql
stable
set search_path = public
as $$
  with paid as (
    select l.class_id, l.instructor_id, l.currency, sum(l.amount) as net
      from payroll_lines l
     where l.kind = 'class'
     group by l.class_id, l.instructor_id, l.currency
  ),
  paying as (
    select distinct l.class_id, l.instructor_id
      from payroll_lines l
     where l.kind = 'class'
       and not l.flags @> array['already_paid']
  ),
  paid_at as (
    select distinct on (l.class_id, l.instructor_id, l.lesson_type_id)
           l.class_id, l.instructor_id, l.lesson_type_id,
           l.hourly_rate, l.rate_unit, l.currency
      from payroll_lines l
     where l.kind = 'class'
       and not l.flags @> array['already_paid']
     order by l.class_id, l.instructor_id, l.lesson_type_id, l.created_at, l.id
  ),
  owed as (
    select c.id as class_id,
           c.instructor_id,
           coalesce(r.currency, 'CAD') as currency,
           case
             when r.hourly_rate is null then 0
             when r.rate_unit = 'day' then round(r.hourly_rate, 2)
             else round(
               round(r.hourly_rate * 100)
               * greatest(0, round(extract(epoch from c.ends_at - c.starts_at) / 60))
               / 60
             ) / 100
           end as amount,
           paid_at.class_id is null and r.hourly_rate is null as needs_rate
      from classes c
      join paying
        on paying.class_id = c.id
       and paying.instructor_id = c.instructor_id
      left join paid_at
        on paid_at.class_id = c.id
       and paid_at.instructor_id = c.instructor_id
       and paid_at.lesson_type_id is not distinct from c.lesson_type_id
      left join lateral (
        select paid_at.hourly_rate, paid_at.rate_unit, paid_at.currency
         where paid_at.class_id is not null
        union all
        select * from (
          select pr.hourly_rate, pr.rate_unit, pr.currency
            from pay_rates pr
           where paid_at.class_id is null
             and pr.lesson_type_id = c.lesson_type_id
             and (pr.instructor_id = c.instructor_id or pr.instructor_id is null)
             and pr.effective_from <= (c.starts_at at time zone 'America/Toronto')::date
             and (pr.effective_to is null
                  or (c.starts_at at time zone 'America/Toronto')::date <= pr.effective_to)
           order by pr.instructor_id is null, pr.effective_from desc
           limit 1
        ) today
      ) r on true
     where c.status <> 'cancelled'
  )
  select c.id
    from classes c
    join paid on paid.class_id = c.id
   where paid.net <> 0
     and (c.status = 'cancelled' or paid.instructor_id <> c.instructor_id)
  union
  select owed.class_id
    from owed
   where owed.needs_rate
      or owed.amount <> coalesce((
           select paid.net
             from paid
            where paid.class_id = owed.class_id
              and paid.instructor_id = owed.instructor_id
              and paid.currency = owed.currency
         ), 0)
      or exists (
           select 1
             from paid
            where paid.class_id = owed.class_id
              and paid.instructor_id = owed.instructor_id
              and paid.currency <> owed.currency
              and paid.net <> 0
         )
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
         from paying
        where paying.class_id = c.id
          and paying.instructor_id = c.instructor_id
     );
$$;

revoke all on function public.payroll_unsettled_class_ids()
  from public, anon, authenticated;
grant execute on function public.payroll_unsettled_class_ids()
  to service_role;
