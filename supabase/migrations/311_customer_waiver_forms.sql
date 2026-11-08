-- Customer waivers: a `form` template kind (waiver text in markdown plus a
-- field list, one version history per language), signed on a public page by
-- customers who need not exist in Shopify yet.

alter table document_templates
  drop constraint document_templates_kind_check,
  add constraint document_templates_kind_check
    check (kind in ('sign', 'read', 'form')),
  add column slug text
    constraint document_templates_slug_format
    check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) <= 60),
  add constraint document_templates_form_has_slug
    check ((kind = 'form') = (slug is not null));

create unique index document_templates_slug_key
  on document_templates (slug)
  where slug is not null;

create table document_form_versions (
  template_id    uuid not null references document_templates (id) on delete cascade,
  language       text not null
                   constraint document_form_versions_language_check
                   check (language in ('en', 'zh')),
  version        int not null
                   constraint document_form_versions_version_positive
                   check (version > 0),
  title          text not null
                   constraint document_form_versions_title_length
                   check (char_length(btrim(title)) between 1 and 200),
  body_markdown  text not null
                   constraint document_form_versions_body_length
                   check (char_length(body_markdown) between 1 and 50000),
  body_sha256    text not null
                   constraint document_form_versions_body_sha256_format
                   check (body_sha256 ~ '^[0-9a-f]{64}$'),
  fields         jsonb not null default '[]'::jsonb
                   constraint document_form_versions_fields_array
                   check (jsonb_typeof(fields) = 'array'),
  published_at   timestamptz,
  published_by   uuid,
  updated_by     uuid,
  inserted_at    timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (template_id, language, version)
);

create unique index document_form_versions_one_draft_key
  on document_form_versions (template_id, language)
  where published_at is null;

create trigger document_form_versions_set_updated_at
  before update on document_form_versions
  for each row execute function public.set_updated_at();

alter table document_form_versions enable row level security;
alter table document_form_versions force row level security;
revoke all on document_form_versions from public, anon, authenticated;

comment on table document_form_versions is
  'Per-language versions of a form template (waiver text and fields); the newest published version is served to signers. service_role only.';

alter table document_assignments
  add column form_version int
    constraint document_assignments_form_version_positive
    check (form_version > 0);

-- A customer may sign the same waiver many times (each child, each season),
-- so only instructor assignments stay unique per template and season.
drop index document_assignments_open_key;
create unique index document_assignments_open_key
  on document_assignments (template_id, subject_type, subject_id, coalesce(season, ''))
  where status <> 'archived' and subject_type = 'instructor';

-- Waiver signers who are not Shopify customers get a row without a Shopify id.
alter table customers alter column shopify_customer_id drop not null;

create or replace function public.reconcile_customer_deletions(
  p_shopify_ids bigint[],
  p_started_at timestamptz
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_deleted int;
  v_restored int;
begin
  update customers c
     set shopify_deleted_at = now()
   where c.shopify_deleted_at is null
     and c.shopify_customer_id is not null
     and c.created_at < p_started_at
     and not exists (
       select 1 from unnest(p_shopify_ids) s (id) where s.id = c.shopify_customer_id
     );
  get diagnostics v_deleted = row_count;

  update customers c
     set shopify_deleted_at = null
   where c.shopify_deleted_at < p_started_at
     and exists (
       select 1 from unnest(p_shopify_ids) s (id) where s.id = c.shopify_customer_id
     );
  get diagnostics v_restored = row_count;

  return jsonb_build_object('deleted', v_deleted, 'restored', v_restored);
end;
$$;

-- The customer a waiver is filed under: the oldest live row with this email
-- (Shopify customers first), else a new row. Serialised per email so two
-- signatures sent at once cannot create two rows.
create function public.waiver_customer_for_email(
  p_email text,
  p_first_name text,
  p_last_name text
) returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_email text := lower(btrim(p_email));
  v_id uuid;
begin
  if v_email is null or v_email = '' then
    raise exception 'waiver_customer_for_email needs p_email' using errcode = '22004';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('waiver_customer:' || v_email, 0));

  select c.id into v_id
    from customers c
   where lower(c.email) = v_email
   order by (c.shopify_deleted_at is not null),
            (c.shopify_customer_id is null),
            c.created_at,
            c.id
   limit 1;

  if v_id is null then
    insert into customers (first_name, last_name, email)
    values (nullif(btrim(p_first_name), ''), nullif(btrim(p_last_name), ''), v_email)
    returning id into v_id;
  end if;

  return v_id;
end;
$$;

revoke all on function public.waiver_customer_for_email(text, text, text)
  from public, anon, authenticated;
grant execute on function public.waiver_customer_for_email(text, text, text)
  to service_role;

create table form_copy_email_claims (
  id          bigint generated always as identity primary key,
  email_hash  text not null
                constraint form_copy_email_claims_email_hash_check
                check (email_hash ~ '^[0-9a-f]{64}$'),
  claimed_at  timestamptz not null default now()
);

create index form_copy_email_claims_email_hash_claimed_at_idx
  on form_copy_email_claims (email_hash, claimed_at);
create index form_copy_email_claims_claimed_at_idx
  on form_copy_email_claims (claimed_at);

alter table form_copy_email_claims enable row level security;
alter table form_copy_email_claims force row level security;
revoke all on form_copy_email_claims from public, anon, authenticated;

create function public.claim_form_copy_email(
  p_email_hash text,
  p_per_recipient int,
  p_recipient_window_seconds int,
  p_global int,
  p_global_window_seconds int
) returns boolean
language plpgsql
security invoker
set search_path = public
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('form_copy_email_claims', 0));

  delete from form_copy_email_claims
   where claimed_at < now() - make_interval(
     secs => greatest(p_recipient_window_seconds, p_global_window_seconds));

  if (select count(*) from form_copy_email_claims
       where email_hash = p_email_hash
         and claimed_at > now() - make_interval(secs => p_recipient_window_seconds))
       >= p_per_recipient
     or (select count(*) from form_copy_email_claims
          where claimed_at > now() - make_interval(secs => p_global_window_seconds))
       >= p_global then
    return false;
  end if;

  insert into form_copy_email_claims (email_hash) values (p_email_hash);
  return true;
end;
$$;

revoke all on function public.claim_form_copy_email(text, int, int, int, int)
  from public, anon, authenticated;
grant execute on function public.claim_form_copy_email(text, int, int, int, int)
  to service_role;
