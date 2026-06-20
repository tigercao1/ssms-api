# Notifications (Mailer) module

Transactional email for admin actions (approve / reject / deactivate). See
`ADMIN_ROLE_PLAN.md` and `AUTH_V1_DECISIONS.md` (Notifications) in the plan repo.

`MailerService.sendInstructorNotification(...)` is **fire-and-forget with retry**:
it never throws and never rolls back the admin action. On final failure it writes
a `notification.failure` row to `audit_log`.

## Architecture

- `EMAIL_SENDER` → `ResendEmailSender` — Resend REST API via global `fetch`
  (no SDK dependency). Swap the binding to change providers.
- `NOTIFICATION_RENDERER` → `I18nNotificationRenderer` (`templates/`) — renders
  `approved` / `rejected` / `deactivated` in **en + zh-CN**, picking the language
  from the instructor's `preferred_language`. Copy is sourced from the shared
  i18n catalog (`src/i18n`, `notification.*`) so there is a single source of
  truth for wording.

## ⚠️ Required environment configuration (TODO — wire up before go-live)

The mailer is intentionally **optional at boot**: if these are unset it logs a
warning and no-ops (no crash, useful in dev/CI). They are NOT in
`config/env.validation.ts` for that reason. **Add these to `.env` / deployment
secrets (and `.env.example`) when wiring Resend for real:**

| Var | Required for sending | Example | Notes |
|---|---|---|---|
| `RESEND_API_KEY` | yes | `re_xxxxxxxx` | Resend API secret. Server-only. |
| `MAIL_FROM` | yes | `Snow School <noreply@yourdomain.com>` | Verified sending domain (SPF/DKIM/DMARC). |

Until both are set, `ResendEmailSender.isConfigured()` returns `false` and
`MailerService` returns the `skipped` outcome instead of sending.
