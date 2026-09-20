# Database migrations

Migrations are plain SQL in `migrations/`, checked into the repo and applied via
the Supabase CLI. This mirrors `backend-architecture.md §6` and `DATABASE_RESET.md`.

## Commands

Every ops command names its target environment explicitly — there is **no
default**. Connection details come from `.env.dev` / `.env.prod` (see
`.env.dev.example`, `.env.prod.example`), never from an ambient `DATABASE_URL`.

```bash
SSMS_ENV=dev  ./scripts/db.sh migrate      # apply every migration, in order
SSMS_ENV=dev  ./scripts/db.sh seed         # apply seed.sql (idempotent)
SSMS_ENV=dev  ./scripts/db.sh counts       # reference-data row counts
SSMS_ENV=dev  ./scripts/db.sh rls          # verify RLS enabled + FORCEd
SSMS_ENV=dev  ./scripts/db.sh dump         # pg_dump public schema
SSMS_ENV=dev  ./scripts/admin.sh bootstrap # create/promote the first admin
```

Swap in `SSMS_ENV=prod` for production. Writes against prod prompt for
confirmation (type the project ref); set `SSMS_CONFIRM_PROD=yes` for
non-interactive use in CI. See `scripts/env.sh` for the guardrails:

- `SSMS_ENV` is required and must be `dev` or `prod`
- each env file self-identifies via `SSMS_ENV_NAME`; a mismatch aborts
- `SSMS_EXPECT_PROJECT_REF` pins the Supabase ref; a mismatch aborts

⚠️ `db.sh migrate` has **no migration tracking table** — it re-applies every
file. Migrations are written to be idempotent; if one fails, fix forward rather
than blind-rerunning.

### Supabase CLI (preferred, not yet adopted for prod)

```bash
supabase link --project-ref <project-ref>   # one-time
supabase db push                            # apply migrations to linked project
supabase db reset                           # rebuild local DB from migrations + seed.sql
supabase db diff --check                    # CI: fail on schema drift (T10.2)
```

This would give tracked migrations and replace the `db.sh migrate` loop.

## Migration naming — ownership prefixes

To let parallel Wave-2 agents add migrations without colliding (see
`../../EXECUTION_PLAN.md` § Ownership boundaries), each owner uses a reserved
numeric prefix range:

| Prefix | Owner | Scope |
|--------|-------|-------|
| `0xx`  | Foundation | scaffold, extensions, base `instructors`, auth glue |
| `01x`  | Foundation/Schema | Wave-1 schema: approval_status, bilingual fields, certs, trainer status, audit_log, RLS |
| `21x`  | Instructor | profile RPCs (transactional update) |
| `22x`  | Reference data | reference tables + seed |
| `23x`  | Bio translation | translation queue table |
| `24x`  | Admin | admin-specific objects |
| `25x`  | Public API | api_keys, public indexes, views |
| `26x`  | Integration (Wave 3) | audit wiring helpers |

Filename format: `<prefix><n>_<short_description>.sql`
e.g. `010_approval_status.sql`, `250_api_keys.sql`.

Seeds go in `seed.sql` (reference data — owned by the Reference-data agent, T4.2).
