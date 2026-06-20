# Database migrations

Migrations are plain SQL in `migrations/`, checked into the repo and applied via
the Supabase CLI. This mirrors `backend-architecture.md §6` and `DATABASE_RESET.md`.

## Commands

```bash
supabase link --project-ref <project-ref>   # one-time
supabase db push                            # apply migrations to linked project
supabase db reset                           # rebuild local DB from migrations + seed.sql
supabase db diff --check                    # CI: fail on schema drift (T10.2)
```

> The Supabase CLI is not yet installed in this environment. Install it before
> running the above: https://supabase.com/docs/guides/cli (e.g. `brew install supabase/tap/supabase`).

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
