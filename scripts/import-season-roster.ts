#!/usr/bin/env ts-node
import 'reflect-metadata';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { InviteDispatcher } from '../src/activation/invite-dispatcher';
import { SupabaseInvitesRepository } from '../src/activation/invites.repository';
import { loadSsmsEnv } from '../src/activation/roster/roster-env';
import { runRosterCli } from '../src/activation/roster/roster-import';
import {
  SupabaseRosterReader,
  SupabaseRosterWriter,
} from '../src/activation/roster/roster-ports';
import { MailerConfig } from '../src/mailer/mailer.config';
import { MailerService } from '../src/mailer/mailer.service';
import { ResendEmailSender } from '../src/mailer/resend-email-sender';
import { EmailRenderer } from '../src/mailer/templates/email-renderer';

async function main(): Promise<void> {
  const repoRoot = path.resolve(__dirname, '..');
  loadSsmsEnv(repoRoot, process.env);
  let client: SupabaseClient | undefined;
  const supabase = () =>
    (client ??= createClient(
      process.env.SUPABASE_URL as string,
      process.env.SUPABASE_SECRET_KEY as string,
      { auth: { persistSession: false, autoRefreshToken: false } },
    ));
  const invites = () => new SupabaseInvitesRepository(supabase());

  await runRosterCli(
    {
      reader: () => new SupabaseRosterReader(supabase()),
      writer: () => new SupabaseRosterWriter(supabase()),
      invites,
      dispatcher: () => {
        const config = new ConfigService(process.env);
        const mailerConfig = new MailerConfig(config);
        const mailer = new MailerService(
          new ResendEmailSender(config),
          new EmailRenderer(mailerConfig),
          mailerConfig,
          supabase(),
        );
        return new InviteDispatcher(invites(), mailer);
      },
      readFile: (file) => fs.readFile(file, 'utf8'),
      writeFile: (file, contents) =>
        fs.writeFile(file, contents, { encoding: 'utf8', mode: 0o600 }),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      log: (line) => console.log(line),
      now: () => new Date(),
      repoRoot,
      env: process.env,
    },
    process.argv.slice(2),
  );
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`import-season-roster failed: ${message}`);
  process.exit(1);
});
