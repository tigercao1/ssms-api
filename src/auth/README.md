# Auth module

JWT verification only — **no password handling in NestJS** (`AUTH_V1_DECISIONS.md`).
Sign-up / sign-in / verification / password-reset all happen client-side via
Supabase Auth; the client then sends `Authorization: Bearer <supabase-jwt>`.

## Pieces
- `SupabaseJwtStrategy` — verifies the **ES256** signature against the project
  **JWKS** (`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`, cached; `kid`-based
  rotation), `aud=authenticated`. Decoded payload → `request.user` (T1.3). No
  shared JWT secret in env.
- JWKS handled by **`jwks-rsa`** (`passportJwtSecret`): fetch + cache + `kid`
  rotation. Requires **Node ≥ 22.12** (jwks-rsa `require()`s ESM `jose@6`);
  pinned via `package.json` engines + `.nvmrc` (24).
- `SupabaseAuthGuard` — `@UseGuards(SupabaseAuthGuard)`; bad/missing token → 401.
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
