alter table pay_rates
  add column if not exists rate_unit text not null default 'hour'
    constraint pay_rates_rate_unit_check
    check (rate_unit in ('hour', 'day'));

alter table payroll_lines
  add column if not exists rate_unit text not null default 'hour'
    constraint payroll_lines_rate_unit_check
    check (rate_unit in ('hour', 'day'));

create or replace function public.payroll_finalize(
  p_period_id uuid,
  p_lines jsonb,
  p_actor uuid
) returns void
language plpgsql
set search_path = public
as $$
declare
  v_status text;
begin
  select status into v_status from payroll_periods
   where id = p_period_id
   for update;
  if not found then
    raise exception 'payroll period not found' using errcode = 'P0002';
  end if;
  if v_status <> 'open' then
    raise exception 'payroll period is finalized' using errcode = '55000';
  end if;

  delete from payroll_lines where period_id = p_period_id and kind = 'class';

  insert into payroll_lines (
    period_id, instructor_id, class_id, kind, description, lesson_type_id,
    class_status, starts_at, ends_at, customer_names, minutes, hourly_rate,
    rate_unit, currency, amount, flags, created_by
  )
  select p_period_id, l.instructor_id, l.class_id, 'class', l.description,
         l.lesson_type_id, l.class_status, l.starts_at, l.ends_at,
         coalesce(l.customer_names, '{}'), l.minutes,
         l.hourly_rate, coalesce(l.rate_unit, 'hour'),
         coalesce(l.currency, 'CAD'), l.amount,
         coalesce(l.flags, '{}'), p_actor
    from jsonb_to_recordset(coalesce(p_lines, '[]'::jsonb)) as l (
      instructor_id uuid, class_id uuid, description text, lesson_type_id uuid,
      class_status text, starts_at timestamptz, ends_at timestamptz,
      customer_names text[], minutes int, hourly_rate numeric, rate_unit text,
      currency text, amount numeric, flags text[]
    );

  update payroll_periods
     set status = 'finalized', finalized_at = now(), finalized_by = p_actor
   where id = p_period_id;
end;
$$;

revoke all on function public.payroll_finalize(uuid, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function public.payroll_finalize(uuid, jsonb, uuid)
  to service_role;
