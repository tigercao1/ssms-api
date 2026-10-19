create function public.certification_upload_reviews(
  p_status text,
  p_since timestamptz,
  p_limit int,
  p_offset int
)
returns table (
  id uuid,
  instructor_id uuid,
  org text,
  track text,
  file_key text,
  sha256 text,
  content_type text,
  size_bytes int,
  review_status text,
  review_note text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  valid_until date,
  verified_level int,
  expiry_reminder_sent_at timestamptz,
  ai_result jsonb,
  ai_model text,
  ai_checked_at timestamptz,
  inserted_at timestamptz,
  updated_at timestamptz,
  is_current boolean,
  level int,
  instructor_email text,
  instructor_first_name text,
  instructor_last_name text,
  instructor_display_name_en text,
  instructor_display_name_zh text,
  total_count int
)
language sql
stable
set search_path = public
as $$
  select
    u.id,
    u.instructor_id,
    u.org,
    u.track,
    u.file_key,
    u.sha256,
    u.content_type,
    u.size_bytes,
    u.review_status,
    u.review_note,
    u.reviewed_by,
    u.reviewed_at,
    u.valid_until,
    u.verified_level,
    u.expiry_reminder_sent_at,
    u.ai_result,
    u.ai_model,
    u.ai_checked_at,
    u.inserted_at,
    u.updated_at,
    cur.is_current,
    c.level,
    i.email,
    i.first_name,
    i.last_name,
    i.display_name_en,
    i.display_name_zh,
    (count(*) over ())::int
  from certification_uploads u
  join instructors i on i.id = u.instructor_id
  left join instructor_certifications c
    on c.instructor_id = u.instructor_id
   and c.org = u.org
   and c.track = u.track
  cross join lateral (
    select not exists (
      select 1
      from certification_uploads n
      where n.instructor_id = u.instructor_id
        and n.org = u.org
        and n.track = u.track
        and (n.inserted_at, n.id) > (u.inserted_at, u.id)
    ) as is_current
  ) cur
  where case p_status
    when 'pending' then u.review_status = 'pending' and cur.is_current
    when 'decided' then u.review_status in ('approved', 'rejected')
                    and u.reviewed_at >= p_since
    else false
  end
  order by
    case when p_status = 'pending' then u.inserted_at end asc,
    case when p_status = 'decided' then u.reviewed_at end desc,
    u.id
  limit p_limit
  offset p_offset;
$$;

revoke all on function public.certification_upload_reviews(text, timestamptz, int, int)
  from public, anon, authenticated;
grant execute on function public.certification_upload_reviews(text, timestamptz, int, int)
  to service_role;
