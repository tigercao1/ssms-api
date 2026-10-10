import * as path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  fetchLegacySnapshot,
  type GraphqlFn,
  type LegacySnapshot,
  legacyEntryName,
} from './legacy-our-team';
import { proposePairs } from './name-matching';
import { formatPairingCsv, parsePairingCsv } from './pairing-csv';

export interface PairingDeps {
  graphql: () => GraphqlFn;
  supabase: () => SupabaseClient;
  readFile: (file: string) => Promise<string>;
  writeFile: (file: string, contents: string) => Promise<void>;
  isDirectory: (dir: string) => Promise<boolean>;
  log: (line: string) => void;
  now: () => Date;
  repoRoot: string;
  env: Record<string, string | undefined>;
}

export class PairingCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PairingCommandError';
  }
}

const MISSING_HANDLE_COLUMN =
  'instructor_shopify_state.shopify_handle does not exist in this database. ' +
  'Apply migration 256 (feat/shopify-sync-worker) before running apply.';

function assertOutsideRepo(deps: PairingDeps, target: string): string {
  const resolved = path.resolve(target);
  const relative = path.relative(path.resolve(deps.repoRoot), resolved);
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
    throw new PairingCommandError(
      `Refusing to write ${resolved}: it is inside the repository and the output contains personal data.`,
    );
  }
  return resolved;
}

export function snapshotFileName(now: Date): string {
  return `our_team-${now.toISOString().replace(/[:.]/g, '-')}.json`;
}

export async function runSnapshot(
  deps: PairingDeps,
  outputDir: string | undefined,
): Promise<string> {
  if (!outputDir) {
    throw new PairingCommandError('Usage: snapshot <output-dir>');
  }
  const dir = assertOutsideRepo(deps, outputDir);
  if (!(await deps.isDirectory(dir))) {
    throw new PairingCommandError(`${dir} is not an existing directory.`);
  }
  const snapshot = await fetchLegacySnapshot(deps.graphql(), deps.now);
  const file = path.join(dir, snapshotFileName(new Date(snapshot.fetchedAt)));
  await deps.writeFile(file, `${JSON.stringify(snapshot, null, 2)}\n`);
  deps.log(
    `Wrote ${snapshot.count} ${snapshot.metaobjectType} entries to ${file}`,
  );
  return file;
}

interface InstructorRow {
  id: string;
  display_name_en: string | null;
  display_name_zh: string | null;
  approval_status: string;
  is_active: boolean;
}

export async function runPropose(
  deps: PairingDeps,
  outputCsv: string | undefined,
  snapshotFile?: string,
): Promise<string> {
  if (!outputCsv) {
    throw new PairingCommandError(
      'Usage: propose <output.csv> [--snapshot <snapshot.json>]',
    );
  }
  const file = assertOutsideRepo(deps, outputCsv);
  const snapshot = snapshotFile
    ? (JSON.parse(await deps.readFile(snapshotFile)) as LegacySnapshot)
    : await fetchLegacySnapshot(deps.graphql(), deps.now);

  const { data, error } = await deps
    .supabase()
    .from('instructors')
    .select('id, display_name_en, display_name_zh, approval_status, is_active')
    .order('display_name_en');
  if (error) {
    throw new PairingCommandError(
      `Failed to read instructors: ${error.message}`,
    );
  }
  const instructors = (data ?? []) as InstructorRow[];

  const proposals = proposePairs(
    instructors.map((i) => ({
      id: i.id,
      displayNameEn: i.display_name_en,
      displayNameZh: i.display_name_zh,
    })),
    snapshot.entries.map((e) => ({
      handle: e.handle,
      name: legacyEntryName(e),
    })),
  );
  await deps.writeFile(file, formatPairingCsv(proposals));
  deps.log(
    `Wrote ${proposals.length} proposal row(s) for ${instructors.length} instructor(s) against ${snapshot.entries.length} legacy entries to ${file}`,
  );
  return file;
}

function isMissingColumn(error: { code?: string; message: string }): boolean {
  return error.code === '42703' || /shopify_handle/.test(error.message);
}

export async function runApply(
  deps: PairingDeps,
  csvFile: string | undefined,
  write: boolean,
): Promise<number> {
  if (!csvFile) {
    throw new PairingCommandError('Usage: apply <reviewed.csv> [--write]');
  }
  if (
    write &&
    deps.env.SSMS_ENV === 'prod' &&
    deps.env.SSMS_CONFIRM_PROD !== 'yes'
  ) {
    throw new PairingCommandError(
      'Refusing to write to PROD without SSMS_CONFIRM_PROD=yes.',
    );
  }
  const pairs = parsePairingCsv(await deps.readFile(csvFile));
  const supabase = deps.supabase();

  const probe = await supabase
    .from('instructor_shopify_state')
    .select('instructor_id, shopify_handle')
    .limit(1);
  if (probe.error) {
    throw new PairingCommandError(
      isMissingColumn(probe.error)
        ? MISSING_HANDLE_COLUMN
        : `Failed to read instructor_shopify_state: ${probe.error.message}`,
    );
  }

  if (pairs.length === 0) {
    deps.log('No rows with confirm=y; nothing to do.');
    return 0;
  }

  const ids = pairs.map((p) => p.instructorId);
  const handles = pairs.map((p) => p.legacyHandle);

  const known = await supabase
    .from('instructors')
    .select('id, display_name_en, display_name_zh')
    .in('id', ids);
  if (known.error) {
    throw new PairingCommandError(
      `Failed to read instructors: ${known.error.message}`,
    );
  }
  const instructors = new Map(
    ((known.data ?? []) as InstructorRow[]).map((i) => [i.id, i]),
  );
  const unknown = pairs.filter((p) => !instructors.has(p.instructorId));
  if (unknown.length > 0) {
    throw new PairingCommandError(
      `Unknown instructor id(s): ${unknown.map((p) => `${p.instructorId} (line ${p.line})`).join(', ')}`,
    );
  }

  const taken = await supabase
    .from('instructor_shopify_state')
    .select('instructor_id, shopify_handle')
    .in('shopify_handle', handles);
  if (taken.error) {
    throw new PairingCommandError(
      `Failed to read instructor_shopify_state: ${taken.error.message}`,
    );
  }
  const owners = new Map(
    (
      (taken.data ?? []) as { instructor_id: string; shopify_handle: string }[]
    ).map((r) => [r.shopify_handle, r.instructor_id]),
  );
  const conflicts = pairs.filter((p) => {
    const owner = owners.get(p.legacyHandle);
    return owner !== undefined && owner !== p.instructorId;
  });
  if (conflicts.length > 0) {
    throw new PairingCommandError(
      `Handle(s) already paired with another instructor: ${conflicts
        .map((p) => `${p.legacyHandle} -> ${owners.get(p.legacyHandle)}`)
        .join(', ')}`,
    );
  }

  const current = await supabase
    .from('instructor_shopify_state')
    .select('instructor_id, shopify_handle')
    .in('instructor_id', ids);
  if (current.error) {
    throw new PairingCommandError(
      `Failed to read instructor_shopify_state: ${current.error.message}`,
    );
  }
  const existing = new Map(
    (
      (current.data ?? []) as {
        instructor_id: string;
        shopify_handle: string | null;
      }[]
    ).map((r) => [r.instructor_id, r.shopify_handle]),
  );

  for (const pair of pairs) {
    const instructor = instructors.get(pair.instructorId)!;
    const name = [instructor.display_name_en, instructor.display_name_zh]
      .filter(Boolean)
      .join(' / ');
    const previous = existing.get(pair.instructorId) ?? '(none)';
    deps.log(
      `${write ? 'SET' : 'WOULD SET'} ${pair.instructorId} [${name}] shopify_handle=${pair.legacyHandle} (was ${previous})`,
    );
  }

  if (!write) {
    deps.log(`Dry run: ${pairs.length} row(s). Re-run with --write to apply.`);
    return 0;
  }

  const { error } = await supabase.from('instructor_shopify_state').upsert(
    pairs.map((p) => ({
      instructor_id: p.instructorId,
      shopify_handle: p.legacyHandle,
    })),
    { onConflict: 'instructor_id' },
  );
  if (error) {
    throw new PairingCommandError(
      isMissingColumn(error)
        ? MISSING_HANDLE_COLUMN
        : `Failed to upsert instructor_shopify_state: ${error.message}`,
    );
  }
  deps.log(`Updated ${pairs.length} row(s).`);
  return pairs.length;
}

export interface ParsedArgs {
  command: string | undefined;
  positional: string[];
  write: boolean;
  snapshot?: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const positional: string[] = [];
  let write = false;
  let snapshot: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--write') {
      write = true;
    } else if (arg === '--snapshot') {
      snapshot = rest[++i];
      if (!snapshot) {
        throw new PairingCommandError('--snapshot needs a file path');
      }
    } else if (arg.startsWith('--')) {
      throw new PairingCommandError(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  return { command, positional, write, snapshot };
}

export async function runPairingCli(
  deps: PairingDeps,
  argv: string[],
): Promise<void> {
  const args = parseArgs(argv);
  if (args.write && args.command !== 'apply') {
    throw new PairingCommandError('--write is only valid for apply');
  }
  switch (args.command) {
    case 'snapshot':
      await runSnapshot(deps, args.positional[0]);
      return;
    case 'propose':
      await runPropose(deps, args.positional[0], args.snapshot);
      return;
    case 'apply':
      await runApply(deps, args.positional[0], args.write);
      return;
    default:
      throw new PairingCommandError(
        'Use one of: snapshot <output-dir> | propose <output.csv> [--snapshot <file>] | apply <reviewed.csv> [--write]',
      );
  }
}
