drop trigger if exists certification_uploads_enqueue_sync
  on certification_uploads;
create trigger certification_uploads_enqueue_sync
  after insert or delete on certification_uploads
  for each row execute function public.enqueue_instructor_sync('instructor_id');

drop trigger if exists certification_uploads_review_enqueue_sync
  on certification_uploads;
create trigger certification_uploads_review_enqueue_sync
  after update on certification_uploads
  for each row
  when (old.instructor_id is distinct from new.instructor_id
        or old.org is distinct from new.org
        or old.track is distinct from new.track
        or old.review_status is distinct from new.review_status
        or old.valid_until is distinct from new.valid_until
        or old.verified_level is distinct from new.verified_level)
  execute function public.enqueue_instructor_sync('instructor_id');

create or replace function public.enqueue_instructor_sync_for_document_subject()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into instructor_sync_queue (instructor_id)
  select distinct (rows.r ->> 'subject_id')::uuid
    from (values (to_jsonb(old)), (to_jsonb(new))) as rows (r)
   where rows.r ->> 'subject_type' = 'instructor'
  on conflict (instructor_id) do update set enqueued_at = now();
  return null;
end;
$$;

revoke all on function public.enqueue_instructor_sync_for_document_subject()
  from public, anon, authenticated;

drop trigger if exists document_assignments_enqueue_sync
  on document_assignments;
create trigger document_assignments_enqueue_sync
  after insert or delete on document_assignments
  for each row execute function public.enqueue_instructor_sync_for_document_subject();

drop trigger if exists document_assignments_status_enqueue_sync
  on document_assignments;
create trigger document_assignments_status_enqueue_sync
  after update on document_assignments
  for each row
  when (old.subject_type is distinct from new.subject_type
        or old.subject_id is distinct from new.subject_id
        or old.template_id is distinct from new.template_id
        or old.season is distinct from new.season
        or old.status is distinct from new.status)
  execute function public.enqueue_instructor_sync_for_document_subject();
