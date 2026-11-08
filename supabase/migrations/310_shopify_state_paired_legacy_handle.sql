alter table instructor_shopify_state
  add column if not exists paired_legacy_handle text;

create unique index if not exists instructor_shopify_state_paired_legacy_handle_key
  on instructor_shopify_state (paired_legacy_handle)
  where paired_legacy_handle is not null;
