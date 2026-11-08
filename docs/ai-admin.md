# Admin API for scripts and AI clients

Admin endpoints (the routes behind the admin role, `@Roles('admin')`) can be called with a personal admin API
token, so a script or an AI client such as Claude Code can do admin work without a browser session. A token works
only on those routes; everywhere else (`/me/*`, `/internal/*`) it gets 403, and seven session-only admin routes
refuse it too (see below).

- Base URL: `https://api.ssnow.club`
- Auth header: `Authorization: Bearer <token>`. A Supabase session JWT from the admin site works the same way.

## Get a token

1. Sign in to the admin site and open **API tokens**.
2. Create a token: give it a name and choose its expiry (30, 90 or 365 days, a custom date up to 3 years ahead,
   or never).
3. Copy the secret. It is shown once and starts with `ssms_pat_`. The API stores only its SHA-256 hash.

A token is personal: it acts as the admin who created it, with full admin access, and stops working within about
30 seconds once that user is no longer an active admin. Treat it like a password.

```sh
export SSMS_API_URL=https://api.ssnow.club
export SSMS_ADMIN_TOKEN=<token>
```

Keep the secret out of shell history, logs, commits and chat transcripts.

## Fetch the API description

`GET /admin/openapi.json` returns an OpenAPI 3 description of the admin endpoints: paths, methods, path and query
parameters, and request body schemas. It is admin-only, like the endpoints it describes. Session-only operations
carry `"x-session-only": true` and say so in their description.

```sh
curl -fsS -H "Authorization: Bearer $SSMS_ADMIN_TOKEN" "$SSMS_API_URL/admin/openapi.json" > ssms-admin-openapi.json
jq -r '.paths | to_entries[] | .key as $p | .value | keys[] | "\(ascii_upcase) \($p)"' ssms-admin-openapi.json
jq -r '.paths | to_entries[] | .key as $p | .value | to_entries[] | select(.value."x-session-only")
  | "\(.key | ascii_upcase) \($p)"' ssms-admin-openapi.json
```

Request body schemas are generated from the DTOs into `src/admin/openapi-metadata.ts`. After adding or changing a
DTO, run `npm run openapi:metadata`; a test fails while the file is stale.

## Bulk-edit instructors

`PATCH /admin/instructors` edits up to 100 instructors in one call. Each row is `{ id, ...fields }`; the allowed
fields are the profile fields of `PATCH /admin/instructors/{id}`, `displayOrder`, `isActive`, and `approvalStatus`
(`approved` or `rejected`) with an optional `reason`. A row carrying `email`, `role` or any other field fails with a
message and nothing in it is applied. Duplicate or malformed ids reject the whole request with 400; ids are
compared without regard to letter case and echoed back in lowercase. At most 25 rows per request may set
`approvalStatus` or `isActive`, because each one sends email and approvals assign documents; a request over that
is rejected with 400 before anything is written, so split it. Rows that only change profile fields or
`displayOrder` can fill the rest of the 100.

Each changed field goes through the same code as its single-row route, so approving still assigns onboarding
documents and sends the approval email, deactivating still sends its email, every change still queues the Shopify
sync, and the per-instructor audit rows are the same. A field that already has the requested value is skipped, so a
repeated request is a no-op. One `admin.instructors.bulk_update` audit row records the counts and the changed
fields per instructor.

The response is 200 with a result per row (`updated`, `unchanged` or `failed` with `error`; `changes` lists the
fields) and a `summary` of the counts. Rows are independent unless you send `atomic: true`: then every row is
checked first and nothing is written if any row fails. The writes are not one database transaction, so if a write
fails part-way the rows before it stay applied, the failing row says what was already applied, and the rest are
reported as not applied. `dryRun: true` checks every row and returns what would change, writing nothing and
auditing nothing. The request body limit is 100 KB; split large bio edits into smaller batches.

```sh
curl -fsS -X PATCH -H "Authorization: Bearer $SSMS_ADMIN_TOKEN" -H 'Content-Type: application/json' \
  "$SSMS_API_URL/admin/instructors" -d '{
    "dryRun": true,
    "updates": [
      { "id": "<instructor-uuid-1>", "displayOrder": 1 },
      { "id": "<instructor-uuid-2>", "displayOrder": 2, "isActive": true }
    ]
  }'
```

Drop `"dryRun": true` to apply the same reorder, and add `"atomic": true` to apply all of it or none of it.

## Session-only routes

These seven routes answer 403 to a token and need a signed-in admin session on the admin site. The list comes
from the `@SessionOnly()` decorator, which also sets `x-session-only` in the OpenAPI document.

| Route | Why a token cannot call it |
| --- | --- |
| `POST /admin/api-tokens` | Token management: a token cannot mint or extend tokens. |
| `GET /admin/api-tokens` | Token management. |
| `POST /admin/api-tokens/{id}/rotate` | Token management: rotating would extend a token. |
| `DELETE /admin/api-tokens/{id}` | Token management. |
| `PATCH /admin/users/{id}/role` | The role decides who is an admin. |
| `PATCH /admin/instructors/{id}/email` | It sets a confirmed sign-in email, so a leaked token could take over an account. |
| `GET /admin/google/connect` | It re-points the organisation's Google calendar. |

## Errors

| Status | Meaning |
| --- | --- |
| 401 | No token, or the token is unknown, revoked or expired, its rotation grace period is over, or its owner is no longer an active admin. |
| 403 | The route is session-only, the route is not an admin route (tokens only work on admin routes), or a session caller is not an admin. |
| 429 | More than 120 requests in a minute with one token. Wait and retry. |
| 503 | The token or its owner could not be checked. Retry later. |

Errors use the usual Nest shape: `{ "statusCode": 403, "message": "...", "error": "Forbidden" }`.

## Rotate or revoke

On the admin site, **API tokens** > **Rotate** issues a new secret (shown once) and keeps the expiry setting
unless you change it. The old secret keeps working for the grace period you choose (0 to 1440 minutes, default
10), then stops. **Revoke** stops a token immediately. Only the owner can rotate or revoke a token, and only from a
session. Rotate at once if a secret may have leaked.

## What is audited

- Every admin action records the acting admin as usual. With a token the actor also carries `via: api_token` and
  the token id.
- `admin_api_token.create`, `.rotate` and `.revoke`, and `admin_api_token.first_use` the first time a token is used.
- `admin_api_token.auth_failure` when a real token is refused: revoked, expired, owner no longer an admin, a
  session-only route or a non-admin route, with the reason, method and path. An unknown or malformed token gets 401
  with no audit row, only a rate-limited warning in the logs. A 429 is not audited.
- Rejected admin requests (`auth.admin_guard_failure`), as before.

The secret itself is never logged or stored. `last_used_at` on a token is updated at most once a minute.
