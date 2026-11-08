# Auth module

JWT verification only — **no password handling in NestJS** (`AUTH_V1_DECISIONS.md`).
Sign-up / sign-in / verification / password-reset all happen client-side via
Supabase Auth; the client then sends `Authorization: Bearer <supabase-jwt>`.

## Pieces
- `SupabaseJwtStrategy` — verifies the **ES256** signature against the project
  **JWKS** (`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`, cached; `kid`-based
  rotation), `aud=authenticated`. Decoded payload → `request.user` (T1.3). No
  shared JWT secret in env.
- `SessionLivenessService` — after the signature checks, the strategy requires a
  `session_id` claim and asks Postgres (`session_is_active` rpc) whether that
  `auth.sessions` row still exists, so a revoked session (sign-out, demotion)
  gets 401 immediately instead of at token expiry. Live results are cached
  in memory for 30s per session; inactive results are never cached. If the
  check itself fails the request gets 503, not 401, so a DB blip does not sign
  the portal out.
- JWKS handled by **`jwks-rsa`** (`passportJwtSecret`): fetch + cache + `kid`
  rotation. Requires **Node ≥ 22.12** (jwks-rsa `require()`s ESM `jose@6`);
  pinned via `package.json` engines + `.nvmrc` (24).
- `SupabaseAuthGuard` — `@UseGuards(SupabaseAuthGuard)`; bad/missing token → 401.
- Admin API tokens — `SupabaseAuthGuard` also accepts `Authorization: Bearer
  ssms_pat_<43 chars>`, a personal admin API token (`src/admin-api-tokens`).
  Only its SHA-256 hash is stored. The guard rejects revoked, expired and
  past-grace tokens, checks the owner is still an admin (cached 30s), limits
  each token to 120 requests a minute (429) and sets `request.user` to the
  owner with `app_metadata.role = 'admin'`, `auth_via: 'api_token'` and
  `token_id`. A token only works on routes marked `@Roles('admin')`, and never
  on a route marked `@SessionOnly()` (403). Every other bearer value takes the
  JWT path above.
- `EmailVerifiedGuard` — use after `SupabaseAuthGuard`; unverified → 403 (T1.2).
- `@CurrentUser()` — injects the verified payload (T1.4).

## Typical controller usage
```ts
@UseGuards(SupabaseAuthGuard, EmailVerifiedGuard)
@Get('me/instructor')
getMe(@CurrentUser() user: SupabaseJwtPayload) { ... }
```

## Admin
Admin = `app_metadata.role === 'admin'` (server-set). The `RolesGuard` lives in
the Admin module (T6.1) and reads the same payload.

## Testing
Mint **ES256** tokens with an ephemeral test key pair and point the strategy at
a local/stubbed JWKS (set `SUPABASE_JWKS_URL`) — `TESTING_STRATEGY.md`. Test
tokens must include `aud: "authenticated"` and, for verified-email paths,
`email_confirmed_at`.
