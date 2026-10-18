# Auth hooks module

HTTP endpoints Supabase Auth calls. Today: the Send Email hook, which renders
every Supabase auth email through the mailer (`src/mailer`) instead of
Supabase's SMTP templates.

## `POST /hooks/auth/send-email`

- **Auth:** no JWT. Every call must carry a valid
  [Standard Webhooks](https://www.standardwebhooks.com/) signature
  (`webhook-id`, `webhook-timestamp`, `webhook-signature`) over the raw body,
  made with `SEND_EMAIL_HOOK_SECRET`. Timestamps older or newer than 5 minutes
  are rejected. The app is created with `rawBody: true` for this.
- **Body:** the Supabase payload, `{ user, email_data }`
  ([reference](https://supabase.com/docs/guides/auth/auth-hooks/send-email-hook)).
- **Success:** `200 {}` once every email was accepted by Resend.
- **Errors:** `{ "error": { "http_code": <status>, "message": "…" } }` with the
  same status, as Supabase expects:

| Status | When                                                     |
| ------ | -------------------------------------------------------- |
| 400    | Signed payload that cannot be addressed (missing fields) |
| 401    | Missing, invalid or stale signature                      |
| 429    | More than 120 calls a minute from one client IP          |
| 500    | Resend failed after retries, or Resend is not configured |
| 503    | `SEND_EMAIL_HOOK_SECRET` is unset or malformed           |

### Action types

| `email_action_type`                  | Template                 | Recipient                          | Content                                                       |
| ------------------------------------ | ------------------------ | ---------------------------------- | ------------------------------------------------------------- |
| `signup`                             | `auth.confirm_signup`    | `user.email`                       | Verify link                                                   |
| `recovery`                           | `auth.recovery`          | `user.email`                       | Verify link                                                   |
| `magiclink`, `email`                 | `auth.magic_link`        | `user.email`                       | Verify link                                                   |
| `invite`                             | `auth.invite`            | `user.email`                       | Verify link                                                   |
| `email_change` (secure, two hashes)  | `auth.email_change` × 2  | `user.email` and `user.new_email`  | Current address: `token_hash_new`; new address: `token_hash`  |
| `email_change` (one hash)            | `auth.email_change`      | `user.new_email`                   | `token_hash`                                                  |
| `reauthentication`                   | `auth.reauthentication`  | `user.email`                       | `token` code only                                             |
| `password_changed_notification`      | `auth.password_changed`  | `user.email`                       | Notice                                                        |
| `email_changed_notification`         | `auth.email_changed`     | `email_data.old_email`             | Notice                                                        |
| `phone_changed_notification`         | `auth.phone_changed`     | `user.email`                       | Notice                                                        |
| `identity_(un)linked_notification`   | `auth.identity_(un)linked` | `user.email`                     | Notice naming `provider`                                      |
| `mfa_factor_(un)enrolled_notification` | `auth.mfa_(un)enrolled` | `user.email`                      | Notice naming `factor_type`                                   |
| anything else                        | `auth.generic`           | `user.email`                       | Bilingual; verify link when `token_hash` is present           |

Verify links are
`${SUPABASE_URL}/auth/v1/verify?token=<hash>&type=<email_action_type>&redirect_to=<redirect_to>`.
Link emails carry no one-time code. The language is the user's instructor
`preferred_language`, or bilingual when they have no instructor row. For an
`en` or `zh-CN` email the `redirect_to` target gets a matching `lang` query
parameter; bilingual emails leave it unchanged.

## Configuration

| Var                      | Notes                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| `SEND_EMAIL_HOOK_SECRET` | `v1,whsec_<base64>`, exactly as Supabase generates it. Separate several with `\|` to rotate. |

In Supabase (Authentication → Hooks → Send Email), choose HTTPS and point it at
`https://<api-host>/hooks/auth/send-email` with the same secret.
