// Environment selection is explicit: SSMS_ENV=dev|prod picks .env.<env>,
// matching scripts/env.sh so the app and the ops scripts can never point
// at different Supabase projects. Plain `.env` remains a fallback for
// local one-offs; real deploys inject env vars directly (Fly secrets),
// where no file exists and this list is simply ignored.
export function envFilePaths(): string[] {
  return [
    ...(process.env.SSMS_ENV ? [`.env.${process.env.SSMS_ENV}`] : []),
    '.env',
  ];
}
