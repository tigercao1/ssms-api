-- Read views (DATA_MODEL.md § Views). Cert display strings + locale selection
-- are computed in the API layer; these views handle row filtering + column
-- hiding only. Consumed by NestJS via the service-role connection.

-- Public: only approved + active; internal columns hidden.
create view v_instructors_public as
select
  id,
  display_name_en,
  display_name_zh,
  bio_en,
  bio_zh,
  profile_photo_url
from instructors
where approval_status = 'approved'
  and is_active = true;

-- Admin: full visibility incl. pending/rejected/inactive + admin-only fields.
create view v_instructors_admin as
select
  id,
  auth_user_id,
  email,
  display_name_en,
  display_name_zh,
  bio_en,
  bio_zh,
  bio_en_machine_translated,
  bio_zh_machine_translated,
  date_of_birth,
  profile_photo_url,
  preferred_language,
  approval_status,
  is_active,
  inserted_at,
  updated_at
from instructors;

-- Views are for the service-role (NestJS) path only; not granted to
-- anon/authenticated (a view bypasses underlying RLS as its owner).
revoke all on v_instructors_public from anon, authenticated;
revoke all on v_instructors_admin from anon, authenticated;
