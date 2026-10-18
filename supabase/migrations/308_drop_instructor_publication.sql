alter table instructors
  drop column if exists published_at,
  drop column if exists published_by;
