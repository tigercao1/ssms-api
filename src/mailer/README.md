# Notifications (Mailer) module

Every transactional email the API sends (instructor status changes, Supabase
auth emails, season invites, admin alerts) goes through `MailerService.send`,
is rendered by one branded layout, and is sent through Resend.

## Sending

```ts
await this.mailer.send({
  template: 'approved',
  to: row.email,
  language: resolveEmailLanguage(row.preferred_language),
  vars: {
    displayName: row.display_name_en,
    loginUrl: this.mailer.portalLink('/login'),
  },
  mode: 'background',
  instructorId: row.id,
  authUserId: row.auth_user_id,
});
```

- `mode: 'background'` retries 3 times and never rejects; callers `void` it.
- `mode: 'sync'` retries 3 times, then throws `EmailDeliveryError` (with
  `outcome: 'failed' | 'skipped'`) when the email was not sent. Use it where a
  user is waiting on the email (the Supabase Send Email hook).
- Every call writes one `email_log` row with the final status (`sent`,
  `skipped`, `failed`), attempt count and provider id. Template vars are never
  logged, since auth links and codes are secrets; put non-secret context in
  `metadata`. A failure also writes a `notification.failure` row to
  `audit_log`.
- `resolveEmailLanguage(preferredLanguage)` returns the instructor's language,
  or `bilingual` when there is no instructor row (en block, divider, zh-CN
  block; subject `"<en> / <zh>"`). Chinese copy brands the club as SSnow; the
  footer keeps "Serendipity Snow Club" in both languages.
- Portal links in instructor emails go through
  `withPortalLanguage(url, language)`, which adds `lang=en` or `lang=zh-CN`
  so the portal opens in the email's language. Bilingual emails get no `lang`.

## Attachments

`send` takes optional `attachments: { filename, content: Buffer, contentType }[]`.
They are sent base64-encoded through Resend. More than 30 MB in total (before
base64; Resend's limit is 40 MB after it) fails without a send attempt. The
`email_log` row records each file's `filename`, `contentType`, `sizeBytes` and
`sha256` under `metadata.attachments`; the content itself is never logged.

## Templates

`EmailTemplate` (`mailer.types.ts`) lists every email; `EmailTemplateVars`
maps each one to its vars. `templates/email-templates.ts` turns vars into
content blocks (heading, greeting, paragraphs, optional red button, optional
code, optional monospaced fingerprint such as a SHA-256, fine print) and holds
the sample vars used by the previews. Each `build` also gets the block's
language, for vars that carry both an English and a Chinese value (document
titles). The copy lives in the i18n catalog under `email.*` (`src/i18n/en`, `src/i18n/zh-CN`).

To add an email:

1. Add the name to `EmailTemplate` and its vars to `EmailTemplateVars`.
2. Add the copy type to `EmailMessages` in `src/i18n/messages.types.ts` and the
   copy to both catalogs.
3. Add a registry entry (`build` + `sample`) in `templates/email-templates.ts`.

`templates/email-layout.ts` is the shared layout: table-based, inline styles
only, 560px card, PNG logo, red `#d71e2b` button with a copy-paste link
fallback, footer with the club name and reply line, and a plain-text
alternative. No SVG, web fonts or external CSS, so it renders in Gmail and
Outlook. Each email declares its language (`<html lang>`, a
`Content-Language` meta tag and the `Content-Language` header; bilingual is
`en, zh-CN`), and links, codes, fingerprints and the club name are marked
`translate="no"` so client auto-translation leaves them intact.

## Previews

Admins can review every email without sending anything:

- `GET /admin/email-previews` — every template with its subject per language
  and preview paths.
- `GET /admin/email-previews/:template?lang=en|zh-CN|bilingual` — the rendered
  HTML with sample vars (`lang` defaults to `bilingual`; add `&format=text` for
  the plain-text part).

## Configuration

All optional at boot; with no Resend key the mailer logs a warning and records
`skipped` instead of sending.

| Var              | Default                                                                           | Notes                                                                                    |
| ---------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `RESEND_API_KEY` | —                                                                                 | Resend API secret. Required to send.                                                     |
| `MAIL_FROM`      | —                                                                                 | Verified sender, e.g. `Serendipity Snow <noreply@contact.ssnow.club>`. Required to send. |
| `MAIL_REPLY_TO`  | `info@ssnow.club`                                                                 | Reply-To on every email.                                                                 |
| `EMAIL_LOGO_URL` | `https://app.ssnow.club/email-logo.png`                                           | PNG logo in the header (served by the portal).                                           |
| `PORTAL_URL`     | `https://app.ssnow.club` when `NODE_ENV=production`, else `http://localhost:5173` | Base for every portal link in emails.                                                    |
