alter table instructor_shopify_state add column if not exists shopify_handle text;

create unique index if not exists instructor_shopify_state_shopify_handle_key
  on instructor_shopify_state (shopify_handle);

create or replace function public.claim_instructor_sync_batch(
  p_limit int default 10,
  p_max_attempts int default 10
) returns setof instructor_sync_queue
language sql
security invoker
set search_path = public
as $$
  select q.*
    from instructor_sync_queue q
   where q.attempts = 0
      or (q.attempts < p_max_attempts
          and q.enqueued_at + make_interval(mins => (2 ^ q.attempts)::int) <= now())
   order by q.enqueued_at
   limit p_limit
   for update skip locked;
$$;

revoke all on function public.claim_instructor_sync_batch(int, int)
  from public, anon, authenticated;
grant execute on function public.claim_instructor_sync_batch(int, int)
  to service_role;

create or replace function public.enqueue_all_instructor_sync()
returns table (instructor_count int, orphaned_count int)
language plpgsql
security invoker
set search_path = public
as $$
begin
  insert into instructor_sync_queue (instructor_id)
  select id from instructors
  union
  select instructor_id from instructor_shopify_state
  on conflict (instructor_id) do update
    set enqueued_at = now(), attempts = 0;

  return query
    select (select count(*)::int from instructors),
           (select count(*)::int
              from instructor_shopify_state s
             where not exists (select 1 from instructors i where i.id = s.instructor_id));
end;
$$;

revoke all on function public.enqueue_all_instructor_sync()
  from public, anon, authenticated;
grant execute on function public.enqueue_all_instructor_sync()
  to service_role;

drop trigger if exists instructors_exam_preparations_enqueue_sync
  on instructors_exam_preparations;
create trigger instructors_exam_preparations_enqueue_sync
  after insert or update or delete on instructors_exam_preparations
  for each row execute function public.enqueue_instructor_sync('instructor_id');

drop trigger if exists exam_preparations_enqueue_sync on exam_preparations;
create trigger exam_preparations_enqueue_sync
  after update on exam_preparations
  for each row
  when (old.name is distinct from new.name
        or old.is_active is distinct from new.is_active)
  execute function public.enqueue_instructor_sync_for_reference(
    'instructors_exam_preparations', 'exam_preparation_id');
