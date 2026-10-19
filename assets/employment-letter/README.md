# Employment letter template

`template.txt` is the letter that `GET /me/employment-letter/letter.pdf` fills in and renders to a
one-page PDF (`src/documents/employment-letter-pdf.ts`). Replace the file with the official wording
when SSnow provides it; no code change is needed.

- A line that starts with `# ` is the heading.
- Line breaks are kept, a blank line adds paragraph spacing, and long lines wrap to the page width.
- English and Simplified Chinese text both render (Noto Sans SC from `assets/fonts`).

| Placeholder | Value |
|---|---|
| `{{legal_name}}` | The instructor's legal first and last name |
| `{{issue_date}}` | Today in Toronto, e.g. October 19, 2026 |
| `{{season}}` | The current season key, e.g. 2026/27 |
| `{{season_start}}` | First day of the current season, e.g. November 1, 2026 |
| `{{season_end}}` | Last day of the current season, e.g. April 30, 2027 |
| `{{email}}` | The instructor's email address |

Any other `{{...}}` in the template makes generation fail, so a typo is caught by the tests rather
than printed on a letter.
