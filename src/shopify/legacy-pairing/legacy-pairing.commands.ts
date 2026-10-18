import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  fetchLegacySnapshot,
  type GraphqlFn,
  type LegacySnapshot,
  legacyEntryName,
} from './legacy-our-team';
import {
  applyInstructorBackfill,
  BACKFILL_AUDIT_ACTION,
  type BackfillInstructor,
  type ExistingTrainerStatus,
  formatBackfillReport,
  type InstructorBackfillPlan,
  planInstructorBackfill,
  type PhotoResult,
  preparePhotos,
} from './legacy-backfill';
import { proposePairs } from './name-matching';
import type { CompressedPhoto } from './photo-compression';
import { formatPairingCsv, parsePairingCsv } from './pairing-csv';

export interface PairingDeps {
  graphql: () => GraphqlFn;
  supabase: () => SupabaseClient;
  readFile: (file: string) => Promise<string>;
  fetchBytes: (url: string) => Promise<Buffer>;
  compressPhoto: (bytes: Buffer) => Promise<CompressedPhoto>;
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

const MISSING_DISMISSED_COLUMN =
  'instructor_shopify_state.dismissed_legacy_handles does not exist in this database. ' +
  'Apply migration 303 before recording confirm=n rows.';

function realPathOfNearestExisting(target: string): string {
  const missing: string[] = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...missing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return path.join(current, ...missing.reverse());
      }
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

function assertOutsideRepo(deps: PairingDeps, target: string): string {
  const resolved = realPathOfNearestExisting(target);
  const relative = path.relative(
    realPathOfNearestExisting(deps.repoRoot),
    resolved,
  );
  if (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  ) {
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

interface StateRow {
  instructor_id: string;
  shopify_handle: string | null;
  dismissed_legacy_handles?: string[] | null;
}

function dismissedColumnError(
  error: { code?: string; message: string },
  fallback: string,
): PairingCommandError {
  return new PairingCommandError(
    error.code === '42703' || /dismissed_legacy_handles/.test(error.message)
      ? MISSING_DISMISSED_COLUMN
      : `${fallback}: ${error.message}`,
  );
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
  const { confirmed: pairs, dismissed } = parsePairingCsv(
    await deps.readFile(csvFile),
  );
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

  if (pairs.length === 0 && dismissed.length === 0) {
    deps.log('No rows with confirm=y or confirm=n; nothing to do.');
    return 0;
  }

  const decisions = [...pairs, ...dismissed].sort((a, b) => a.line - b.line);
  const ids = [...new Set(decisions.map((p) => p.instructorId))];
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
  const unknown = decisions.filter((p) => !instructors.has(p.instructorId));
  if (unknown.length > 0) {
    throw new PairingCommandError(
      `Unknown instructor id(s): ${unknown.map((p) => `${p.instructorId} (line ${p.line})`).join(', ')}`,
    );
  }

  if (pairs.length > 0) {
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
        (taken.data ?? []) as {
          instructor_id: string;
          shopify_handle: string;
        }[]
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
  }

  const current = await supabase
    .from('instructor_shopify_state')
    .select(
      dismissed.length > 0
        ? 'instructor_id, shopify_handle, dismissed_legacy_handles'
        : 'instructor_id, shopify_handle',
    )
    .in('instructor_id', ids);
  if (current.error) {
    if (dismissed.length > 0) {
      throw dismissedColumnError(
        current.error,
        'Failed to read instructor_shopify_state',
      );
    }
    throw new PairingCommandError(
      `Failed to read instructor_shopify_state: ${current.error.message}`,
    );
  }
  const existing = new Map(
    ((current.data ?? []) as unknown as StateRow[]).map((r) => [
      r.instructor_id,
      r,
    ]),
  );

  const dismissingPairing = dismissed.filter(
    (d) =>
      existing.get(d.instructorId)?.shopify_handle === d.legacyHandle &&
      !pairs.some((p) => p.instructorId === d.instructorId),
  );
  if (dismissingPairing.length > 0) {
    throw new PairingCommandError(
      `Cannot dismiss the legacy handle an instructor is paired with: ${dismissingPairing
        .map((d) => `${d.legacyHandle} -> ${d.instructorId} (line ${d.line})`)
        .join(', ')}`,
    );
  }

  const nameOf = (id: string) => {
    const instructor = instructors.get(id)!;
    return [instructor.display_name_en, instructor.display_name_zh]
      .filter(Boolean)
      .join(' / ');
  };
  for (const pair of pairs) {
    const previous =
      existing.get(pair.instructorId)?.shopify_handle ?? '(none)';
    deps.log(
      `${write ? 'SET' : 'WOULD SET'} ${pair.instructorId} [${nameOf(pair.instructorId)}] shopify_handle=${pair.legacyHandle} (was ${previous})`,
    );
  }
  for (const pair of dismissed) {
    deps.log(
      `${write ? 'DISMISS' : 'WOULD DISMISS'} ${pair.instructorId} [${nameOf(pair.instructorId)}] legacy_handle=${pair.legacyHandle} (not the same person)`,
    );
  }

  const total = pairs.length + dismissed.length;
  if (!write) {
    deps.log(`Dry run: ${total} row(s). Re-run with --write to apply.`);
    return 0;
  }

  if (pairs.length > 0) {
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
  }

  if (dismissed.length > 0) {
    const dismissedIds = [...new Set(dismissed.map((d) => d.instructorId))];
    const { error } = await supabase.from('instructor_shopify_state').upsert(
      dismissedIds.map((id) => ({
        instructor_id: id,
        dismissed_legacy_handles: [
          ...new Set([
            ...(existing.get(id)?.dismissed_legacy_handles ?? []),
            ...dismissed
              .filter((d) => d.instructorId === id)
              .map((d) => d.legacyHandle),
          ]),
        ].sort(),
      })),
      { onConflict: 'instructor_id' },
    );
    if (error) {
      throw dismissedColumnError(
        error,
        'Failed to upsert instructor_shopify_state',
      );
    }
    const queued = await supabase.from('instructor_sync_queue').upsert(
      dismissedIds.map((id) => ({
        instructor_id: id,
        enqueued_at: deps.now().toISOString(),
        attempts: 0,
      })),
      { onConflict: 'instructor_id' },
    );
    if (queued.error) {
      throw new PairingCommandError(
        `Failed to queue a Shopify sync: ${queued.error.message}`,
      );
    }
    deps.log(`Queued a Shopify sync for ${dismissedIds.length} instructor(s).`);
  }
  deps.log(`Updated ${total} row(s).`);
  return total;
}

const BACKFILL_INSTRUCTOR_COLUMNS =
  'id, display_name_en, display_name_zh, bio_en, bio_zh, display_order, ' +
  'profile_photo_url, photo_2_url, photo_3_url';

export async function runBackfill(
  deps: PairingDeps,
  reportCsv: string | undefined,
  options: { write: boolean; snapshot?: string; force: string[] },
): Promise<number> {
  if (!reportCsv) {
    throw new PairingCommandError(
      'Usage: backfill <report.csv> [--snapshot <snapshot.json>] [--force <handle>]... [--write]',
    );
  }
  if (
    options.write &&
    deps.env.SSMS_ENV === 'prod' &&
    deps.env.SSMS_CONFIRM_PROD !== 'yes'
  ) {
    throw new PairingCommandError(
      'Refusing to write to PROD without SSMS_CONFIRM_PROD=yes.',
    );
  }
  const report = assertOutsideRepo(deps, reportCsv);
  const snapshot = options.snapshot
    ? (JSON.parse(await deps.readFile(options.snapshot)) as LegacySnapshot)
    : await fetchLegacySnapshot(deps.graphql(), deps.now);
  const entries = new Map(snapshot.entries.map((e) => [e.handle, e]));
  const supabase = deps.supabase();

  const pairs = await supabase
    .from('instructor_shopify_state')
    .select('instructor_id, shopify_handle')
    .not('shopify_handle', 'is', null);
  if (pairs.error) {
    throw new PairingCommandError(
      `Failed to read instructor_shopify_state: ${pairs.error.message}`,
    );
  }
  const paired = (
    (pairs.data ?? []) as { instructor_id: string; shopify_handle: string }[]
  ).filter((p) => entries.has(p.shopify_handle));
  const unknownForce = options.force.filter(
    (h) => !paired.some((p) => p.shopify_handle === h),
  );
  if (unknownForce.length > 0) {
    throw new PairingCommandError(
      `--force handle(s) not paired with an instructor: ${unknownForce.join(', ')}`,
    );
  }
  const ids = paired.map((p) => p.instructor_id);
  if (ids.length === 0) {
    deps.log('No paired instructors with a legacy entry; nothing to do.');
    return 0;
  }

  const done = await supabase
    .from('audit_log')
    .select('target_id')
    .eq('action', BACKFILL_AUDIT_ACTION)
    .in('target_id', ids);
  if (done.error) {
    throw new PairingCommandError(
      `Failed to read audit_log: ${done.error.message}`,
    );
  }
  const alreadyBackfilled = new Set(
    ((done.data ?? []) as { target_id: string }[]).map((r) => r.target_id),
  );

  const rows = await supabase
    .from('instructors')
    .select(BACKFILL_INSTRUCTOR_COLUMNS)
    .in('id', ids);
  if (rows.error) {
    throw new PairingCommandError(
      `Failed to read instructors: ${rows.error.message}`,
    );
  }
  const instructors = new Map(
    ((rows.data ?? []) as unknown as BackfillInstructor[]).map((i) => [
      i.id,
      i,
    ]),
  );

  const trainer = await supabase
    .from('instructor_trainer_status')
    .select('instructor_id, discipline, trainer_level')
    .in('instructor_id', ids);
  if (trainer.error) {
    throw new PairingCommandError(
      `Failed to read instructor_trainer_status: ${trainer.error.message}`,
    );
  }
  const trainerRows = (trainer.data ?? []) as (ExistingTrainerStatus & {
    instructor_id: string;
  })[];

  const io = {
    supabase,
    bucket: deps.env.SUPABASE_STORAGE_BUCKET?.trim() || 'instructor-public',
    fetchBytes: deps.fetchBytes,
    compress: deps.compressPhoto,
    log: deps.log,
  };

  const planned: {
    plan: InstructorBackfillPlan;
    instructor: BackfillInstructor;
    photos: PhotoResult[];
  }[] = [];
  for (const pair of paired) {
    const instructor = instructors.get(pair.instructor_id);
    if (!instructor) {
      continue;
    }
    if (
      alreadyBackfilled.has(pair.instructor_id) &&
      !options.force.includes(pair.shopify_handle)
    ) {
      deps.log(`SKIP ${pair.shopify_handle}: already backfilled`);
      continue;
    }
    const plan = planInstructorBackfill(
      entries.get(pair.shopify_handle)!,
      instructor,
      trainerRows.filter((t) => t.instructor_id === pair.instructor_id),
    );
    const photos = await preparePhotos(io, plan);
    planned.push({ plan, instructor, photos });
    const sizes = photos
      .map(
        (p) =>
          `${p.field} ${Math.round(p.originalBytes / 1024)}->${Math.round(p.compressedBytes / 1024)} KB`,
      )
      .join(', ');
    deps.log(
      `${options.write ? 'BACKFILL' : 'WOULD BACKFILL'} ${plan.handle} [${plan.name}]: ` +
        `${photos.length} photo(s)${sizes ? ` (${sizes})` : ''}; ` +
        `fields: ${
          Object.keys(plan.update)
            .filter((k) => !k.includes('translat'))
            .join(', ') || 'none'
        }` +
        `${plan.translateBioToEn ? '; bio_en translation queued' : ''}` +
        `${plan.trainer ? `; trainer ${plan.trainer.discipline} L${plan.trainer.level}` : ''}`,
    );
  }

  await deps.writeFile(report, formatBackfillReport(planned));
  const original = planned.reduce(
    (sum, p) => sum + p.photos.reduce((s, x) => s + x.originalBytes, 0),
    0,
  );
  const stored = planned.reduce(
    (sum, p) => sum + p.photos.reduce((s, x) => s + x.compressedBytes, 0),
    0,
  );
  deps.log(
    `Photos: ${(original / 1e6).toFixed(1)} MB original -> ${(stored / 1e6).toFixed(1)} MB stored. Report: ${report}`,
  );

  if (!options.write) {
    deps.log(
      `Dry run: ${planned.length} instructor(s). Re-run with --write to apply.`,
    );
    return 0;
  }

  for (const { plan, instructor, photos } of planned) {
    await applyInstructorBackfill(io, plan, instructor, photos, deps.now());
    deps.log(`Done ${plan.handle}`);
  }
  deps.log(`Backfilled ${planned.length} instructor(s).`);
  return planned.length;
}

export interface ParsedArgs {
  command: string | undefined;
  positional: string[];
  write: boolean;
  snapshot?: string;
  force: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const positional: string[] = [];
  let write = false;
  let snapshot: string | undefined;
  const force: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--write') {
      write = true;
    } else if (arg === '--snapshot') {
      snapshot = rest[++i];
      if (!snapshot) {
        throw new PairingCommandError('--snapshot needs a file path');
      }
    } else if (arg === '--force') {
      const handle = rest[++i];
      if (!handle) {
        throw new PairingCommandError('--force needs a legacy handle');
      }
      force.push(handle);
    } else if (arg.startsWith('--')) {
      throw new PairingCommandError(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  return { command, positional, write, snapshot, force };
}

export async function runPairingCli(
  deps: PairingDeps,
  argv: string[],
): Promise<void> {
  const args = parseArgs(argv);
  if (args.write && args.command !== 'apply' && args.command !== 'backfill') {
    throw new PairingCommandError(
      '--write is only valid for apply and backfill',
    );
  }
  if (args.force.length > 0 && args.command !== 'backfill') {
    throw new PairingCommandError('--force is only valid for backfill');
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
    case 'backfill':
      await runBackfill(deps, args.positional[0], {
        write: args.write,
        snapshot: args.snapshot,
        force: args.force,
      });
      return;
    default:
      throw new PairingCommandError(
        'Use one of: snapshot <output-dir> | propose <output.csv> [--snapshot <file>] | apply <reviewed.csv> [--write] | backfill <report.csv> [--snapshot <file>] [--force <handle>]... [--write]',
      );
  }
}
