# Database migrations

Migrations are plain SQL in `migrations/`. `scripts/migrate.sh` applies each file
exactly once and records it in `ssms_meta.schema_migrations` (filename, sha256
checksum, git SHA). All pending files run in one transaction: if any fails, none
are applied.

## Commands

Every ops command names its target environment explicitly — there is **no
default**. Connection details come from `.env.dev` / `.env.prod` (see
`.env.dev.example`, `.env.prod.example`), never from an ambient `DATABASE_URL`.

```bash
SSMS_ENV=dev  ./scripts/db.sh migrate          # status: applied / pending
SSMS_ENV=dev  ./scripts/db.sh migrate apply    # apply pending migrations
SSMS_ENV=dev  ./scripts/db.sh seed             # apply seed.sql (idempotent)
SSMS_ENV=dev  ./scripts/db.sh counts           # reference-data row counts
SSMS_ENV=dev  ./scripts/db.sh rls              # verify RLS enabled + FORCEd
SSMS_ENV=dev  ./scripts/db.sh dump             # pg_dump public schema
SSMS_ENV=dev  ./scripts/admin.sh bootstrap     # create/promote the first admin
```

Swap in `SSMS_ENV=prod` for production. Writes against prod prompt for
confirmation (type the project ref); set `SSMS_CONFIRM_PROD=yes` for
non-interactive use in CI. See `scripts/env.sh` for the guardrails:

- `SSMS_ENV` is required and must be `dev` or `prod`
- each env file self-identifies via `SSMS_ENV_NAME`; a mismatch aborts
- `SSMS_EXPECT_PROJECT_REF` pins the Supabase ref; a mismatch aborts

`migrate apply` refuses to run if an applied file was edited (checksum differs)
or is missing from the repo. `migrate baseline <file>` records files up to
`<file>` as applied without running them; it is only for adopting tracking on a
database that already has those migrations.

## Rules for new migrations

Checked on every PR by `scripts/check-migrations.sh` (`Migration rules` workflow):

1. Files already on `main` are immutable. To change something, add a new file.
   Exception: a migration that failed and was never applied anywhere may be
   fixed in place with the `migration:edit-unapplied` label. The runner still
   refuses to run if an edited file is recorded as applied.
2. Name new files `NNN_snake_case.sql`, numbered above every file on `main`.
3. No `begin` / `commit` / `rollback` and no `create index concurrently`: the
   runner owns the transaction.
4. Migrations run before the new code is deployed, so they must work with the
   code that is already live. Destructive statements (`drop table`/`column`/
   `schema`, `rename`, `truncate`, `delete from`, `set not null`, column type
   changes) fail the check unless the PR has the `migration:destructive` label.
   Drop a column in a later PR, after the code that reads it is gone.

CI also builds a fresh database from every migration, and applies the PR's new
files on top of a database built from the base branch.

Seeds go in `seed.sql` (reference data — owned by the Reference-data agent, T4.2).

## Release pipeline

`.github/workflows/release.yml` runs after CI passes on a push to `main`:

1. **Migrate dev**: `scripts/migrate.sh apply` against the dev project.
2. **Back up and migrate prod**: if anything is pending, an encrypted dump of
   prod is uploaded as the `pre-migration-backup-<run id>` artifact, then
   `apply`.
3. **Deploy**: `flyctl deploy` of the same commit.

Each stage needs the previous one. Database and Fly credentials live in the
`dev` and `production` GitHub Environments, which only `main` can use.
`.github/workflows/schema-drift.yml` compares dev and prod every night.

Do not change either schema outside this pipeline (Supabase dashboard, manual
`psql`): the nightly check will fail.

If a stage fails:

- **Dev failed**: nothing was applied anywhere, so the next release would fail
  the same way. Fix the file in a new PR with the `migration:edit-unapplied`
  label.
- **Prod failed, dev succeeded**: prod is unchanged and the deploy did not run,
  but dev is ahead. Usually a data problem dev does not have (e.g. `set not null`
  over existing nulls). Fix the data on prod, then re-run the Release workflow
  (Actions → Release → Run workflow). Prod cannot move past that migration
  until it applies, so a later corrective migration does not help on its own.
- **Deploy failed**: migrations are applied; re-run the workflow, which skips
  them and deploys again.
- **Migration applied but was wrong**: write a new migration that reverses it.
  Restoring the pre-migration backup is the last resort, since it loses every
  write made after the dump.

## Backups

`.github/workflows/backup.yml` dumps the prod `public` schema daily
(`scripts/backup-db.sh`) and uploads it as the `db-backup` artifact, encrypted
with [age](https://age-encryption.org) to the public key in the
`BACKUP_AGE_RECIPIENT` repo variable. Only the holder of the matching private
key can read it. Release runs upload `pre-migration-backup-<run id>` the same way.

```bash
gh run download <run-id> -n db-backup
age -d -i <path-to-private-key> ssms-prod-YYYYMMDD.sql.age > ssms-prod-YYYYMMDD.sql
SSMS_ENV=<env> ./scripts/db.sh file ssms-prod-YYYYMMDD.sql
```
