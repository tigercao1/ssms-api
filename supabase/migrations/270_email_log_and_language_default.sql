alter table instructors alter column preferred_language set default 'zh-CN';

create table email_log (
  id            uuid primary key default gen_random_uuid(),
  template      text not null,
  recipient     text not null,
  language      text not null
                  constraint email_log_language_check
                  check (language in ('en', 'zh-CN', 'bilingual')),
  instructor_id uuid references instructors (id) on delete set null,
  auth_user_id  uuid,
  provider_id   text,
  status        text not null
                  constraint email_log_status_check
                  check (status in ('sent', 'skipped', 'failed')),
  error         text,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index email_log_template_created_at_idx
  on email_log (template, created_at);

create index email_log_instructor_id_idx
  on email_log (instructor_id);

alter table email_log enable row level security;
alter table email_log force row level security;
revoke all on email_log from public, anon, authenticated;

comment on table email_log is
  'One row per transactional email send (sent, skipped or failed); written by the API only, service_role only.';
