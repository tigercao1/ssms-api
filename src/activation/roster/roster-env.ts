import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseEnv } from 'node:util';
import { DEFAULT_PORTAL_URL, isLocalUrl } from '../../mailer/mailer.config';

export type EnvMap = Record<string, string | undefined>;

export interface EnvFiles {
  exists: (file: string) => boolean;
  read: (file: string) => string;
}

const realFiles: EnvFiles = {
  exists: (file) => fs.existsSync(file),
  read: (file) => fs.readFileSync(file, 'utf8'),
};

/**
 * Loads `.env.<SSMS_ENV>` into `env` (existing values win), with the same
 * guards as `scripts/env.sh`: SSMS_ENV must be dev or prod, the file's
 * SSMS_ENV_NAME must match, and SSMS_EXPECT_PROJECT_REF must match the URL.
 * For prod, links in emails default to the production portal and may never
 * point at a local one.
 */
export function loadSsmsEnv(
  repoRoot: string,
  env: EnvMap,
  files: EnvFiles = realFiles,
): void {
  const target = env.SSMS_ENV;
  if (target !== 'dev' && target !== 'prod') {
    throw new Error(
      `SSMS_ENV must be 'dev' or 'prod' (got: '${target ?? ''}'). There is no default.`,
    );
  }
  const file = path.join(repoRoot, `.env.${target}`);
  if (files.exists(file)) {
    for (const [key, value] of Object.entries(parseEnv(files.read(file)))) {
      if (env[key] === undefined) {
        env[key] = value;
      }
    }
  }
  if (env.SSMS_ENV_NAME && env.SSMS_ENV_NAME !== target) {
    throw new Error(
      `${file} declares SSMS_ENV_NAME=${env.SSMS_ENV_NAME} but was loaded as '${target}'.`,
    );
  }
  const ref = /^https:\/\/([^.]+)\./.exec(env.SUPABASE_URL ?? '')?.[1];
  if (env.SSMS_EXPECT_PROJECT_REF && env.SSMS_EXPECT_PROJECT_REF !== ref) {
    throw new Error(
      `Project ref mismatch: expected '${env.SSMS_EXPECT_PROJECT_REF}' but SUPABASE_URL resolves to '${ref ?? ''}'.`,
    );
  }
  if (target === 'prod') {
    env.PORTAL_URL = env.PORTAL_URL?.trim() || DEFAULT_PORTAL_URL;
    if (isLocalUrl(env.PORTAL_URL)) {
      throw new Error(
        `PORTAL_URL is ${env.PORTAL_URL}, a local address; prod emails must link to the real portal.`,
      );
    }
  }
  for (const key of ['SUPABASE_URL', 'SUPABASE_SECRET_KEY']) {
    if (!env[key]?.trim()) {
      throw new Error(`${key} is not set (expected in ${file}).`);
    }
  }
}
