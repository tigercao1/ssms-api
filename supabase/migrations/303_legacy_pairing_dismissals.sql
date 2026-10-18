alter table instructor_shopify_state
  add column if not exists dismissed_legacy_handles text[] not null default '{}';
