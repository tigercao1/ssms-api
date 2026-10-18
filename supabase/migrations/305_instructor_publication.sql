alter table instructors
  add column if not exists published_at timestamptz,
  add column if not exists published_by uuid;
