import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseEnv } from 'node:util';

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
  for (const key of ['SUPABASE_URL', 'SUPABASE_SECRET_KEY']) {
    if (!env[key]?.trim()) {
      throw new Error(`${key} is not set (expected in ${file}).`);
    }
  }
}
