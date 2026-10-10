#!/usr/bin/env ts-node
import 'reflect-metadata';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import { ShopifyAdminClient } from '../src/shopify/shopify-admin.client';
import { runPairingCli } from '../src/shopify/legacy-pairing/legacy-pairing.commands';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function main(): Promise<void> {
  await runPairingCli(
    {
      graphql: () => {
        const client = new ShopifyAdminClient(new ConfigService(process.env));
        return (query, variables) => client.graphql(query, variables);
      },
      supabase: () =>
        createClient(
          requireEnv('SUPABASE_URL'),
          requireEnv('SUPABASE_SECRET_KEY'),
          { auth: { persistSession: false, autoRefreshToken: false } },
        ),
      readFile: (file) => fs.readFile(file, 'utf8'),
      writeFile: (file, contents) =>
        fs.writeFile(file, contents, {
          encoding: 'utf8',
          flag: 'wx',
          mode: 0o600,
        }),
      isDirectory: async (dir) => {
        try {
          return (await fs.stat(dir)).isDirectory();
        } catch {
          return false;
        }
      },
      log: (line) => console.log(line),
      now: () => new Date(),
      repoRoot: path.resolve(__dirname, '..'),
      env: process.env,
    },
    process.argv.slice(2),
  );
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`shopify-legacy failed: ${message}`);
  process.exit(1);
});
