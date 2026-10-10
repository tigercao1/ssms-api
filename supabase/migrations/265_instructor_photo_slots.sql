alter table instructors add column if not exists photo_2_url text;
alter table instructors add column if not exists photo_2_version timestamptz;
alter table instructors add column if not exists photo_3_url text;
alter table instructors add column if not exists photo_3_version timestamptz;

alter table instructor_shopify_state add column if not exists shopify_photo_2_file_id text;
alter table instructor_shopify_state add column if not exists synced_photo_2_version timestamptz;
alter table instructor_shopify_state add column if not exists shopify_photo_3_file_id text;
alter table instructor_shopify_state add column if not exists synced_photo_3_version timestamptz;
