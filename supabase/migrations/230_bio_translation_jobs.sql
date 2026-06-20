-- T5.2 Bio translation queue (scaffold). See BIO_TRANSLATION_PLAN.md.
--
-- A Postgres-backed job queue keeps v1 dependency-free (no BullMQ/Redis): the
-- API enqueues a row after a profile save, a background worker polls due rows,
-- calls the bound BioTranslator, writes the missing bio field, and sets the
-- matching machine_translated flag. The real provider is wired post-v1 by
-- swapping the DI binding — this table and worker are unchanged.

create table bio_translation_jobs (
  id             uuid primary key default gen_random_uuid(),

  instructor_id  uuid not null references instructors (id) on delete cascade,

  -- Translate `source_lang` -> `target_lang`. They must differ.
  source_lang    text not null check (source_lang in ('en', 'zh-CN')),
  target_lang    text not null check (target_lang in ('en', 'zh-CN')),
  constraint bio_translation_jobs_distinct_langs
    check (source_lang <> target_lang),

  -- Snapshot of the source text at enqueue time. If the user edits the source
  -- again before the job runs, a fresh job supersedes this one (see worker).
  source_text    text not null,

  status         text not null default 'pending'
                   check (status in ('pending', 'processing', 'completed',
                                     'skipped', 'failed')),

  attempts       integer not null default 0,
  max_attempts   integer not null default 3,
  last_error     text,

  -- Backoff gate: the worker only picks rows whose run_after has passed.
  run_after      timestamptz not null default now(),

  inserted_at    timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Worker poll path: due, runnable jobs in FIFO order.
create index bio_translation_jobs_due_idx
  on bio_translation_jobs (status, run_after)
  where status in ('pending', 'processing');

-- One pending/processing job per instructor+target at a time (idempotent
-- enqueue): a re-edit upserts instead of stacking duplicates.
create unique index bio_translation_jobs_active_uniq
  on bio_translation_jobs (instructor_id, target_lang)
  where status in ('pending', 'processing');

create index bio_translation_jobs_instructor_idx
  on bio_translation_jobs (instructor_id);

create trigger bio_translation_jobs_set_updated_at
  before update on bio_translation_jobs
  for each row execute function public.set_updated_at();

-- Internal queue: no anon/authenticated access. NestJS uses the service-role
-- key (BYPASSRLS); RLS here is deny-by-default defense-in-depth (no policies).
alter table bio_translation_jobs enable row level security;
alter table bio_translation_jobs force row level security;

comment on table bio_translation_jobs is
  'Async bio translation queue (T5.2). service_role only; worker-processed.';
comment on column bio_translation_jobs.run_after is
  'Backoff gate — worker skips rows until now() >= run_after.';
