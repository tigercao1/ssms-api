# Admin API for scripts and AI clients

Every admin endpoint (the routes behind `RolesGuard`) can be called with a personal admin API token, so a script
or an AI client such as Claude Code can do admin work without a browser session.

- Base URL: `https://api.ssnow.club`
- Auth header: `Authorization: Bearer <token>`. A Supabase session JWT from the admin site works the same way.

## Get a token

1. Sign in to the admin site and open **API tokens**.
2. Create a token: give it a name and choose its expiry (30, 90 or 365 days, a custom date, or never).
3. Copy the secret. It is shown once and starts with `ssms_pat_`. The API stores only its SHA-256 hash.

A token is personal: it acts as the admin who created it, with full admin access, and stops working as soon as
that user is no longer an active admin. Treat it like a password.

```sh
export SSMS_API_URL=https://api.ssnow.club
export SSMS_ADMIN_TOKEN=<token>
```

Keep the secret out of shell history, logs, commits and chat transcripts.

## Fetch the API description

`GET /admin/openapi.json` returns an OpenAPI 3 description of the admin endpoints: paths, methods, path and query
parameters, and request body schemas. It is admin-only, like the endpoints it describes.

```sh
curl -fsS -H "Authorization: Bearer $SSMS_ADMIN_TOKEN" "$SSMS_API_URL/admin/openapi.json" > ssms-admin-openapi.json
jq -r '.paths | to_entries[] | .key as $p | .value | keys[] | "\(ascii_upcase) \($p)"' ssms-admin-openapi.json
```

Request body schemas are generated from the DTOs into `src/admin/openapi-metadata.ts`. After adding or changing a
DTO, run `npm run openapi:metadata`; a test fails while the file is stale.

## Session-only routes

These answer 403 to a token and need a signed-in admin session on the admin site. This list is provisional until
the token guard is merged:

- Creating, listing, rotating and revoking API tokens (`/admin/api-tokens`).
- Changing a user's role (`PATCH /admin/users/{id}/role`).
- Deleting or deactivating admins, and anything else that changes who can sign in as an admin.

## Errors

| Status | Meaning |
| --- | --- |
| 401 | No token, or the token is unknown, revoked or expired, its rotation grace period is over, or its owner is no longer an active admin. |
| 403 | The route is session-only, the route is not an admin route (tokens only work on admin routes), or a session caller is not an admin. |
| 429 | More than 120 requests in a minute with one token. Wait and retry. |
| 503 | The token could not be checked. Retry later. |

Errors use the usual Nest shape: `{ "statusCode": 403, "message": "...", "error": "Forbidden" }`.

## Rotate or revoke

On the admin site, **API tokens** > **Rotate** issues a new secret (shown once) and keeps the expiry setting
unless you change it. The old secret keeps working for the grace period you choose (0 to 1440 minutes, default
10), then stops. **Revoke** stops a token immediately. Only the owner can rotate or revoke a token, and only from a
session. Rotate at once if a secret may have leaked.

## What is audited

- Every admin action records the acting admin as usual. With a token the audit row also says `via: api_token` and
  carries the token id.
- Token created, rotated and revoked, a token's first use, and failed token attempts. The secret itself is never
  logged or stored.
- Rejected admin requests (`auth.admin_guard_failure`), as before.

`last_used_at` on a token is updated at most once a minute.
