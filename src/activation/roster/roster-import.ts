import * as fs from 'node:fs';
import * as path from 'node:path';
import { EmailDeliveryError } from '../../mailer/mailer.types';
import type { InviteRecipient } from '../activation.types';
import { normalizeEmail } from '../activation.service';
import type { InviteDispatcher, InviteTemplate } from '../invite-dispatcher';
import type { DeliveryKind, InvitesRepository } from '../invites.repository';
import {
  parseRosterCsv,
  type RosterEntry,
  type RosterRawValues,
} from './roster-csv';
import {
  buildLlmRequest,
  validateLlmResult,
  type RosterLlmNormalizer,
} from './roster-llm';
import {
  describeCertification,
  describeTrainerStatus,
  keepHighest,
  mergeTrainerStatus,
  type ValueSource,
} from './roster-normalize';
import type {
  ExistingAuthUser,
  RosterReader,
  RosterWriter,
} from './roster-ports';

export const DEFAULT_SEASON = '2026/27';
export const SEND_INTERVAL_MS = 500;

export type RosterMode =
  | 'dry-run'
  | 'apply'
  | 'send'
  | 'remind'
  | 'release-stale-claims';

export interface RosterOptions {
  mode: RosterMode;
  csv?: string;
  season: string;
  only?: string;
  report?: string;
  staleClaimMinutes?: number;
  normalizeWithLlm?: boolean;
}

export const NO_REFERENCE_ROW =
  'no reference row — add in admin Reference data if wanted';
const KEY_NOT_IN_DATABASE = '(key not in database)';

export interface RowReview {
  raw: RosterRawValues;
  certifications: { certification: string; source: ValueSource }[];
  trainerStatus: { trainer: string; source: ValueSource }[];
  locations: { key: string; source: ValueSource }[];
  llmProposals: { value: string; proposal: string }[];
  unresolved: {
    kind: 'certification' | 'location';
    value: string;
    note?: string;
  }[];
}

export type RowStatus =
  | 'create'
  | 'created'
  | 'resumed'
  | 'repaired'
  | 'already_imported'
  | 'existing_user'
  | 'failed';

export interface RowReport {
  line: number;
  email: string;
  status: RowStatus;
  displayNameSource: RosterEntry['displayNameSource'];
  dateOfBirth: RosterEntry['dateOfBirthStatus'];
  certifications: number;
  trainerStatus: number;
  locations: number;
  unmappedCertifications: string[];
  unmappedLocations: string[];
  llmCertifications: number;
  llmTrainerStatus: number;
  llmLocations: number;
  review?: RowReview;
  relationsWritten?: boolean;
  error?: string;
}

export interface ImportReport {
  mode: 'dry-run' | 'apply';
  env: string;
  season: string;
  generatedAt: string;
  counts: Record<string, number>;
  unmappedValues: {
    certifications: Record<string, number>;
    locations: Record<string, number>;
  };
  existingUsers: string[];
  invalidEmailLines: number[];
  duplicates: { email: string; lines: number[] }[];
  rows: RowReport[];
}

export interface DeliveryReport {
  mode: 'send' | 'remind';
  env: string;
  season: string;
  generatedAt: string;
  counts: {
    candidates: number;
    sent: number;
    failed: number;
    skipped: number;
    needsReview: number;
  };
  failed: { email: string; error: string }[];
  /** Invite ids claimed but never marked delivered; check Resend before releasing. */
  needsReview: string[];
}

export interface ReleaseReport {
  mode: 'release-stale-claims';
  env: string;
  season: string;
  generatedAt: string;
  claimedBefore: string;
  released: Record<DeliveryKind, string[]>;
}

export interface RosterDeps {
  reader: () => RosterReader;
  writer: () => RosterWriter;
  invites: () => InvitesRepository;
  dispatcher: () => InviteDispatcher;
  llm?: () => RosterLlmNormalizer;
  readFile: (file: string) => Promise<string>;
  writeFile: (file: string, contents: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  now: () => Date;
  repoRoot: string;
  env: Record<string, string | undefined>;
}

export class RosterCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RosterCommandError';
  }
}

export const USAGE =
  'Usage: import-season-roster --csv <path> [--dry-run | --apply] [--normalize-with-llm] [--report <path>] [--season <label>]\n' +
  '       import-season-roster --send [--only <email>] [--report <path>] [--season <label>]\n' +
  '       import-season-roster --remind [--report <path>] [--season <label>]\n' +
  '       import-season-roster --release-stale-claims <minutes> [--report <path>] [--season <label>]';

const RELEASE_HINT =
  'After checking Resend that these were not delivered, release claims older than N minutes with: import-season-roster --release-stale-claims <N> [--season <label>]';

const MODE_FLAGS: Record<string, RosterMode> = {
  '--dry-run': 'dry-run',
  '--apply': 'apply',
  '--send': 'send',
  '--remind': 'remind',
};
const LLM_FLAG = '--normalize-with-llm';
const VALUE_FLAGS = [
  '--csv',
  '--only',
  '--report',
  '--season',
  '--release-stale-claims',
] as const;

/** Parses CLI flags; dry-run is the default mode. */
export function parseRosterArgs(argv: string[]): RosterOptions {
  const modes = new Set<RosterMode>();
  const values: Partial<Record<(typeof VALUE_FLAGS)[number], string>> = {};
  let normalizeWithLlm = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === LLM_FLAG) {
      normalizeWithLlm = true;
      continue;
    }
    if (arg in MODE_FLAGS) {
      modes.add(MODE_FLAGS[arg]);
      continue;
    }
    const flag = VALUE_FLAGS.find((f) => f === arg);
    const value = argv[i + 1];
    if (!flag || value === undefined || value.startsWith('--')) {
      throw new RosterCommandError(`Unexpected argument ${arg}\n${USAGE}`);
    }
    values[flag] = value;
    i++;
  }
  const staleClaims = values['--release-stale-claims'];
  if (staleClaims !== undefined) {
    modes.add('release-stale-claims');
  }
  if (modes.size > 1) {
    throw new RosterCommandError(`Pick one mode\n${USAGE}`);
  }
  const mode = [...modes][0] ?? 'dry-run';
  if ((mode === 'dry-run' || mode === 'apply') && !values['--csv']) {
    throw new RosterCommandError(`--csv is required for ${mode}\n${USAGE}`);
  }
  if (normalizeWithLlm && mode !== 'dry-run' && mode !== 'apply') {
    throw new RosterCommandError(
      `${LLM_FLAG} works with --dry-run and --apply only\n${USAGE}`,
    );
  }
  if (values['--only'] !== undefined && mode !== 'send') {
    throw new RosterCommandError(`--only works with --send only\n${USAGE}`);
  }
  if (staleClaims !== undefined && !/^[1-9][0-9]*$/.test(staleClaims)) {
    throw new RosterCommandError(
      `--release-stale-claims needs a whole number of minutes\n${USAGE}`,
    );
  }
  return {
    mode,
    csv: values['--csv'],
    season: values['--season'] ?? DEFAULT_SEASON,
    only:
      values['--only'] === undefined
        ? undefined
        : normalizeEmail(values['--only']),
    report: values['--report'],
    staleClaimMinutes:
      staleClaims === undefined ? undefined : Number(staleClaims),
    normalizeWithLlm,
  };
}

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

/** Resolves `target`, refusing any path inside the repository. */
export function assertOutsideRepo(repoRoot: string, target: string): string {
  const resolved = realPathOfNearestExisting(target);
  const relative = path.relative(realPathOfNearestExisting(repoRoot), resolved);
  if (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  ) {
    throw new RosterCommandError(
      `Refusing to write ${resolved}: it is inside the repository and the report contains personal data.`,
    );
  }
  return resolved;
}

function tally(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const v of values) {
    counts[v] = (counts[v] ?? 0) + 1;
  }
  return counts;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface Plan {
  rows: RowReport[];
  entries: RosterEntry[];
  users: Map<string, ExistingAuthUser>;
  locationIds: Map<string, string>;
  parsed: ReturnType<typeof parseRosterCsv>;
}

async function plan(
  deps: RosterDeps,
  reader: RosterReader,
  options: RosterOptions,
): Promise<Plan> {
  const parsed = parseRosterCsv(
    await deps.readFile(options.csv as string),
    deps.now(),
  );
  const normalized = options.normalizeWithLlm
    ? await normalizeWithLlm(deps, parsed.entries)
    : parsed.entries;
  const users = await reader.authUsersByEmail();
  const wantedKeys = [...new Set(normalized.flatMap((e) => e.locationKeys))];
  const locationIds = await reader.teachingLocationIds(wantedKeys);
  const entries = normalized.map((entry) => {
    const missing = entry.locationKeys.filter((k) => !locationIds.has(k));
    return missing.length === 0
      ? entry
      : {
          ...entry,
          locationKeys: entry.locationKeys.filter((k) => locationIds.has(k)),
          llmLocationKeys: entry.llmLocationKeys.filter((k) =>
            locationIds.has(k),
          ),
          unmappedLocations: [
            ...entry.unmappedLocations,
            ...missing.map((k) => `${k} ${KEY_NOT_IN_DATABASE}`),
          ],
        };
  });
  const rows = entries.map((entry): RowReport => {
    const user = users.get(entry.email);
    const status: RowStatus = !user
      ? 'create'
      : user.importedSeason === options.season
        ? 'already_imported'
        : 'existing_user';
    return {
      line: entry.line,
      email: entry.email,
      status,
      displayNameSource: entry.displayNameSource,
      dateOfBirth: entry.dateOfBirthStatus,
      certifications: entry.certifications.length,
      trainerStatus: entry.trainerStatus.length,
      locations: entry.locationKeys.length,
      unmappedCertifications: entry.unmappedCertifications,
      unmappedLocations: entry.unmappedLocations,
      llmCertifications: entry.certifications.filter((c) => c.source === 'llm')
        .length,
      llmTrainerStatus: entry.trainerStatus.filter((t) => t.source === 'llm')
        .length,
      llmLocations: entry.llmLocationKeys.length,
      review: reviewOf(entry),
    };
  });
  return { rows, entries, users, locationIds, parsed };
}

function reviewOf(entry: RosterEntry): RowReview | undefined {
  const llmUsed = entry.llmRejected.length > 0 || entry.llmResolved.length > 0;
  if (!entry.needsReview && !llmUsed) {
    return undefined;
  }
  const llmNote = (value: string) =>
    entry.llmRejected.find((r) => r.value === value)?.reason;
  const withNote = (note: string | undefined, extra?: string) =>
    [extra, note === undefined ? undefined : `LLM: ${note}`]
      .filter((n) => n !== undefined)
      .join('; ') || undefined;
  return {
    raw: entry.raw,
    certifications: entry.certifications.map((c) => ({
      certification: describeCertification(c),
      source: c.source,
    })),
    trainerStatus: entry.trainerStatus.map((t) => ({
      trainer: describeTrainerStatus(t),
      source: t.source,
    })),
    locations: entry.locationKeys.map((key) => ({
      key,
      source: entry.llmLocationKeys.includes(key) ? 'llm' : 'rule',
    })),
    llmProposals: entry.llmResolved,
    unresolved: [
      ...entry.unmappedCertifications.map((value) => ({
        kind: 'certification' as const,
        value,
        note: withNote(llmNote(value)),
      })),
      ...entry.unmappedLocations.map((value) => ({
        kind: 'location' as const,
        value,
        note: value.endsWith(KEY_NOT_IN_DATABASE)
          ? undefined
          : withNote(llmNote(value), NO_REFERENCE_ROW),
      })),
    ],
  };
}

async function normalizeEntryWithLlm(
  deps: RosterDeps,
  llm: RosterLlmNormalizer,
  entry: RosterEntry,
): Promise<RosterEntry> {
  const request = buildLlmRequest(
    entry.raw,
    entry.unmappedCertifications,
    entry.unmappedLocations,
  );
  let output: unknown;
  try {
    output = await llm.normalize(request);
  } catch (err) {
    deps.log(`  line ${entry.line}: LLM request failed: ${errorMessage(err)}`);
    return {
      ...entry,
      llmRejected: [
        ...request.unresolvedCertifications,
        ...request.unresolvedLocations,
      ].map((value) => ({ value, reason: 'request failed' })),
    };
  }
  const result = validateLlmResult(output, request);
  const certValues = [
    ...result.certifications.map((c) => c.value),
    ...result.trainerStatus.map((t) => t.value),
  ];
  const locationValues = result.locations.map((l) => l.value);
  const newKeys = [
    ...new Set(
      result.locations
        .map((l) => l.key)
        .filter((k) => !entry.locationKeys.includes(k)),
    ),
  ];
  return {
    ...entry,
    certifications: keepHighest([
      ...entry.certifications,
      ...result.certifications.map((c) => ({
        ...c.certification,
        source: 'llm' as const,
      })),
    ]),
    trainerStatus: mergeTrainerStatus([
      ...entry.trainerStatus,
      ...result.trainerStatus.map((t) => ({
        ...t.trainerStatus,
        source: 'llm' as const,
      })),
    ]),
    unmappedCertifications: entry.unmappedCertifications.filter(
      (v) => !certValues.includes(v),
    ),
    locationKeys: [...entry.locationKeys, ...newKeys],
    llmLocationKeys: newKeys,
    unmappedLocations: entry.unmappedLocations.filter(
      (v) => !locationValues.includes(v),
    ),
    llmRejected: result.rejected,
    llmResolved: [
      ...result.certifications.map((c) => ({
        value: c.value,
        proposal: describeCertification(c.certification),
      })),
      ...result.trainerStatus.map((t) => ({
        value: t.value,
        proposal: describeTrainerStatus(t.trainerStatus),
      })),
      ...result.locations.map((l) => ({ value: l.value, proposal: l.key })),
    ],
  };
}

/**
 * Sends each row that still has unresolved certification or location values
 * to the LLM, one row at a time and only its raw certification and location
 * strings, and keeps only validated answers.
 */
async function normalizeWithLlm(
  deps: RosterDeps,
  entries: RosterEntry[],
): Promise<RosterEntry[]> {
  const pending = entries.filter(
    (e) =>
      e.unmappedCertifications.length > 0 || e.unmappedLocations.length > 0,
  );
  if (pending.length === 0) {
    deps.log('LLM normalisation: no unresolved values');
    return entries;
  }
  if (!deps.llm) {
    throw new RosterCommandError(
      `${LLM_FLAG} needs an LLM provider (set GEMINI_API_KEY).`,
    );
  }
  const llm = deps.llm();
  deps.log(
    `LLM normalisation (${llm.modelId}): ${pending.length} row(s) with unresolved values`,
  );
  const result: RosterEntry[] = [];
  for (const entry of entries) {
    result.push(
      pending.includes(entry)
        ? await normalizeEntryWithLlm(deps, llm, entry)
        : entry,
    );
  }
  return result;
}

async function applyEntry(
  writer: RosterWriter,
  entry: RosterEntry,
  user: ExistingAuthUser | undefined,
  locationIds: Map<string, string>,
  season: string,
): Promise<{ status: RowStatus; wroteRelations: boolean }> {
  const authUserId = user?.id ?? (await writer.createUser(entry.email, season));
  const existingInstructorId = await writer.findInstructorId(authUserId);
  const instructorId =
    existingInstructorId ??
    (await writer.insertInstructor({
      authUserId,
      email: entry.email,
      displayNameEn: entry.displayNameEn,
      dateOfBirth: entry.dateOfBirth,
    }));
  const hasRelations =
    entry.certifications.length > 0 ||
    entry.locationKeys.length > 0 ||
    entry.trainerStatus.length > 0;
  const writesRelations =
    hasRelations &&
    (existingInstructorId === null ||
      !(await writer.hasProfileRelations(instructorId)));
  if (writesRelations) {
    await writer.setProfileRelations(
      instructorId,
      entry.certifications,
      entry.locationKeys.map((k) => locationIds.get(k) as string),
      entry.trainerStatus,
    );
  }
  const createdInvite = await writer.insertInvite({
    instructor_id: instructorId,
    auth_user_id: authUserId,
    email: entry.email,
    season,
  });
  const status: RowStatus = !user
    ? 'created'
    : existingInstructorId === null
      ? 'resumed'
      : writesRelations || createdInvite
        ? 'repaired'
        : 'already_imported';
  return { status, wroteRelations: writesRelations };
}

function llmToWrite(
  rows: RowReport[],
  field: 'llmCertifications' | 'llmTrainerStatus' | 'llmLocations',
): number {
  return rows
    .filter((r) =>
      r.relationsWritten === undefined
        ? r.status !== 'existing_user' && r.status !== 'failed'
        : r.relationsWritten,
    )
    .reduce((n, r) => n + r[field], 0);
}

function buildImportReport(
  deps: RosterDeps,
  options: RosterOptions,
  result: Plan,
): ImportReport {
  const { rows, parsed } = result;
  const count = (status: RowStatus) =>
    rows.filter((r) => r.status === status).length;
  return {
    mode: options.mode as 'dry-run' | 'apply',
    env: deps.env.SSMS_ENV ?? 'unknown',
    season: options.season,
    generatedAt: deps.now().toISOString(),
    counts: {
      csvRows:
        parsed.entries.length +
        parsed.invalidEmailLines.length +
        parsed.duplicates.reduce((n, d) => n + d.lines.length - 1, 0),
      uniqueEmails: parsed.entries.length,
      invalidEmail: parsed.invalidEmailLines.length,
      duplicateEmails: parsed.duplicates.length,
      toCreate: count('create'),
      created: count('created'),
      resumed: count('resumed'),
      repaired: count('repaired'),
      alreadyImported: count('already_imported'),
      existingUsers: count('existing_user'),
      failed: count('failed'),
      displayNameFromLegalFirstToken: rows.filter(
        (r) => r.displayNameSource === 'legal_first_token',
      ).length,
      displayNameMissing: rows.filter((r) => r.displayNameSource === 'none')
        .length,
      dateOfBirthInvalid: rows.filter((r) => r.dateOfBirth === 'invalid')
        .length,
      dateOfBirthMissing: rows.filter((r) => r.dateOfBirth === 'missing')
        .length,
      rowsWithUnmappedCertifications: rows.filter(
        (r) => r.unmappedCertifications.length > 0,
      ).length,
      rowsWithUnmappedLocations: rows.filter(
        (r) => r.unmappedLocations.length > 0,
      ).length,
      rowsWithoutCertification: rows.filter((r) => r.certifications === 0)
        .length,
      rowsNeedingReview: rows.filter((r) => r.review !== undefined).length,
      llmCertificationsToWrite: llmToWrite(rows, 'llmCertifications'),
      llmTrainerStatusToWrite: llmToWrite(rows, 'llmTrainerStatus'),
      llmLocationsToWrite: llmToWrite(rows, 'llmLocations'),
    },
    unmappedValues: {
      certifications: tally(rows.flatMap((r) => r.unmappedCertifications)),
      locations: tally(rows.flatMap((r) => r.unmappedLocations)),
    },
    existingUsers: rows
      .filter((r) => r.status === 'existing_user')
      .map((r) => r.email),
    invalidEmailLines: parsed.invalidEmailLines,
    duplicates: parsed.duplicates,
    rows,
  };
}

function printImportReport(deps: RosterDeps, report: ImportReport): void {
  deps.log(
    `Mode: ${report.mode} · env ${report.env} · season ${report.season}`,
  );
  for (const [key, value] of Object.entries(report.counts)) {
    deps.log(`  ${key}: ${value}`);
  }
  deps.log('Unmapped certification values:');
  for (const [value, n] of Object.entries(
    report.unmappedValues.certifications,
  )) {
    deps.log(`  ${JSON.stringify(value)} × ${n}`);
  }
  deps.log('Unmapped location values:');
  for (const [value, n] of Object.entries(report.unmappedValues.locations)) {
    deps.log(`  ${JSON.stringify(value)} × ${n}`);
  }
  printReview(deps, report.rows);
  const llmValues = `${report.counts.llmCertificationsToWrite} certification(s), ${report.counts.llmTrainerStatusToWrite} trainer status(es), ${report.counts.llmLocationsToWrite} location(s)`;
  deps.log(
    report.mode === 'apply'
      ? `LLM-derived values written by this run: ${llmValues}. Unresolved values were not written.`
      : `LLM-derived values --apply would write (only with ${LLM_FLAG}, re-derived and re-validated in that run): ${llmValues}. Unresolved values are never written.`,
  );
  if (report.existingUsers.length > 0) {
    deps.log('Already in auth.users (skipped):');
    for (const email of report.existingUsers) {
      deps.log(`  ${email}`);
    }
  }
  for (const row of report.rows.filter((r) => r.status === 'failed')) {
    deps.log(`  line ${row.line} failed: ${row.error}`);
  }
}

function printReview(deps: RosterDeps, rows: RowReport[]): void {
  const reviewed = rows.filter((r) => r.review !== undefined);
  if (reviewed.length === 0) {
    return;
  }
  deps.log('Normalisation review (by CSV line):');
  for (const row of reviewed) {
    const review = row.review as RowReview;
    deps.log(`  line ${row.line}`);
    deps.log(
      `    raw certifications: ${JSON.stringify(review.raw.certifications)}`,
    );
    deps.log(
      `    raw certification details: ${JSON.stringify(review.raw.certificationDetails)}`,
    );
    deps.log(`    raw locations: ${JSON.stringify(review.raw.locations)}`);
    for (const c of review.certifications) {
      deps.log(`    certification ${c.certification} (${c.source})`);
    }
    for (const t of review.trainerStatus) {
      deps.log(`    trainer ${t.trainer} (${t.source})`);
    }
    for (const l of review.locations) {
      deps.log(`    location ${l.key} (${l.source})`);
    }
    for (const p of review.llmProposals) {
      deps.log(`    llm read ${JSON.stringify(p.value)} as ${p.proposal}`);
    }
    for (const u of review.unresolved) {
      deps.log(
        `    ${u.kind} ${JSON.stringify(u.value)} (unresolved${u.note ? `: ${u.note}` : ''})`,
      );
    }
  }
}

async function writeReport(
  deps: RosterDeps,
  options: RosterOptions,
  report: ImportReport | DeliveryReport | ReleaseReport,
): Promise<void> {
  if (!options.report) {
    return;
  }
  const target = assertOutsideRepo(deps.repoRoot, options.report);
  await deps.writeFile(target, `${JSON.stringify(report, null, 2)}\n`);
  deps.log(`Report written to ${target}`);
}

/** Parses and maps the CSV and compares it with the target DB. Reads only. */
export async function runDryRun(
  deps: RosterDeps,
  options: RosterOptions,
): Promise<ImportReport> {
  if (options.report) {
    assertOutsideRepo(deps.repoRoot, options.report);
  }
  const report = buildImportReport(
    deps,
    options,
    await plan(deps, deps.reader(), options),
  );
  printImportReport(deps, report);
  await writeReport(deps, options, report);
  return report;
}

/**
 * Creates the auth user, pending instructor, certifications, locations,
 * trainer status and an unsent invite per new email. Users that exist and were not created by this
 * season's import are skipped untouched. Users it did create are completed:
 * a missing instructor or invite is added, and certifications, locations and
 * trainer status are written only when the instructor has none of them yet.
 */
export async function runApply(
  deps: RosterDeps,
  options: RosterOptions,
): Promise<ImportReport> {
  if (options.report) {
    assertOutsideRepo(deps.repoRoot, options.report);
  }
  const result = await plan(deps, deps.reader(), options);
  const writer = deps.writer();
  for (const [i, row] of result.rows.entries()) {
    if (row.status === 'existing_user') {
      continue;
    }
    const entry = result.entries[i];
    try {
      const applied = await applyEntry(
        writer,
        entry,
        result.users.get(entry.email),
        result.locationIds,
        options.season,
      );
      row.status = applied.status;
      row.relationsWritten = applied.wroteRelations;
    } catch (err) {
      row.status = 'failed';
      row.error = errorMessage(err);
    }
  }
  const report = buildImportReport(deps, options, result);
  printImportReport(deps, report);
  await writeReport(deps, options, report);
  return report;
}

const DELIVERED_LABEL: Record<DeliveryKind, string> = {
  send: 'sent',
  remind: 'reminded',
};

/** Resend `Idempotency-Key` for one claimed dispatch. */
export function inviteIdempotencyKey(
  inviteId: string,
  kind: DeliveryKind,
  claimedAt: Date,
): string {
  return `invite-${inviteId}-${kind === 'send' ? 'sent' : 'remind'}-${claimedAt.toISOString()}`;
}

function deliveryError(err: unknown): string {
  return err instanceof EmailDeliveryError
    ? `${err.outcome}: ${err.message}`
    : errorMessage(err);
}

type DeliveryOutcome = 'sent' | 'failed' | 'skipped' | 'needs_review';

async function deliverOne(
  deps: RosterDeps,
  invites: InvitesRepository,
  dispatcher: InviteDispatcher,
  invite: InviteRecipient,
  kind: DeliveryKind,
  template: InviteTemplate,
  failed: DeliveryReport['failed'],
): Promise<DeliveryOutcome> {
  const claimedAt = deps.now();
  try {
    if (!(await invites.claim(invite.id, kind, claimedAt))) {
      deps.log(`  skipped invite ${invite.id}: claimed by another run`);
      return 'skipped';
    }
  } catch (err) {
    const error = deliveryError(err);
    failed.push({ email: invite.email, error });
    deps.log(`  FAILED ${template} to ${invite.email}: ${error}`);
    return 'failed';
  }
  try {
    await dispatcher.dispatch(
      invite,
      template,
      'sync',
      claimedAt,
      inviteIdempotencyKey(invite.id, kind, claimedAt),
    );
  } catch (err) {
    const error = deliveryError(err);
    failed.push({ email: invite.email, error });
    deps.log(`  FAILED ${template} to ${invite.email}: ${error}`);
    try {
      await invites.releaseClaim(invite.id, kind, claimedAt);
      return 'failed';
    } catch (releaseErr) {
      deps.log(
        `  could not release the claim on invite ${invite.id}: ${errorMessage(releaseErr)}`,
      );
      return 'needs_review';
    }
  }
  try {
    if (kind === 'send') {
      await invites.markSent(invite.id, claimedAt);
    } else {
      await invites.markReminded(invite.id, claimedAt);
    }
  } catch (err) {
    deps.log(
      `  sent ${template} to ${invite.email} but could not mark invite ${invite.id} ${DELIVERED_LABEL[kind]}: ${errorMessage(err)}`,
    );
    return 'needs_review';
  }
  deps.log(`  sent ${template} to ${invite.email}`);
  return 'sent';
}

async function deliver(
  deps: RosterDeps,
  options: RosterOptions,
  invites: InvitesRepository,
  candidates: InviteRecipient[],
  kind: DeliveryKind,
  template: InviteTemplate,
): Promise<DeliveryReport> {
  const needsReview = await invites.listUnfinishedClaims(options.season, kind);
  const dispatcher = deps.dispatcher();
  const failed: DeliveryReport['failed'] = [];
  let sent = 0;
  let skipped = 0;
  for (const [i, invite] of candidates.entries()) {
    if (i > 0) {
      await deps.sleep(SEND_INTERVAL_MS);
    }
    const outcome = await deliverOne(
      deps,
      invites,
      dispatcher,
      invite,
      kind,
      template,
      failed,
    );
    if (outcome === 'sent') {
      sent++;
    } else if (outcome === 'skipped') {
      skipped++;
    } else if (outcome === 'needs_review') {
      needsReview.push(invite.id);
    }
  }
  const report: DeliveryReport = {
    mode: options.mode as 'send' | 'remind',
    env: deps.env.SSMS_ENV ?? 'unknown',
    season: options.season,
    generatedAt: deps.now().toISOString(),
    counts: {
      candidates: candidates.length,
      sent,
      failed: failed.length,
      skipped,
      needsReview: needsReview.length,
    },
    failed,
    needsReview,
  };
  deps.log(
    `Mode: ${report.mode} · candidates ${candidates.length} · sent ${sent} · failed ${failed.length} · skipped ${skipped} · needs review ${needsReview.length}`,
  );
  if (needsReview.length > 0) {
    deps.log(
      `Needs review: claimed but never marked ${DELIVERED_LABEL[kind]}, so not sent again: ${needsReview.join(', ')}`,
    );
    deps.log(RELEASE_HINT);
  }
  await writeReport(deps, options, report);
  return report;
}

/** Emails `invite.season` to every unsent, unclaimed invite (or just `--only`), ≤ 2 per second. */
export async function runSend(
  deps: RosterDeps,
  options: RosterOptions,
): Promise<DeliveryReport> {
  if (options.report) {
    assertOutsideRepo(deps.repoRoot, options.report);
  }
  const invites = deps.invites();
  const candidates = await invites.listUnsent(options.season, options.only);
  return deliver(deps, options, invites, candidates, 'send', 'invite.season');
}

/** Emails `invite.reminder` to unclaimed invites sent ≥ 7 days ago, unredeemed, unreminded and unexpired. */
export async function runRemind(
  deps: RosterDeps,
  options: RosterOptions,
): Promise<DeliveryReport> {
  if (options.report) {
    assertOutsideRepo(deps.repoRoot, options.report);
  }
  const invites = deps.invites();
  const candidates = await invites.listDueForReminder(
    options.season,
    deps.now(),
  );
  return deliver(
    deps,
    options,
    invites,
    candidates,
    'remind',
    'invite.reminder',
  );
}

/**
 * Clears send and reminder claims older than `--release-stale-claims` minutes
 * that were never marked delivered, so the next run emails them again.
 */
export async function runReleaseStaleClaims(
  deps: RosterDeps,
  options: RosterOptions,
): Promise<ReleaseReport> {
  if (options.report) {
    assertOutsideRepo(deps.repoRoot, options.report);
  }
  const invites = deps.invites();
  const claimedBefore = new Date(
    deps.now().getTime() - (options.staleClaimMinutes as number) * 60_000,
  );
  const released: ReleaseReport['released'] = { send: [], remind: [] };
  for (const kind of ['send', 'remind'] as const) {
    released[kind] = await invites.releaseStaleClaims(
      options.season,
      kind,
      claimedBefore,
    );
    deps.log(
      `Released ${released[kind].length} ${kind} claim(s) taken before ${claimedBefore.toISOString()}${released[kind].length > 0 ? `: ${released[kind].join(', ')}` : ''}`,
    );
  }
  const report: ReleaseReport = {
    mode: 'release-stale-claims',
    env: deps.env.SSMS_ENV ?? 'unknown',
    season: options.season,
    generatedAt: deps.now().toISOString(),
    claimedBefore: claimedBefore.toISOString(),
    released,
  };
  await writeReport(deps, options, report);
  return report;
}

/** Writing modes against prod need `SSMS_CONFIRM_PROD=yes` (the wrapper asks first). */
export function assertProdConfirmed(
  env: Record<string, string | undefined>,
  mode: RosterMode,
): void {
  if (
    mode !== 'dry-run' &&
    env.SSMS_ENV === 'prod' &&
    env.SSMS_CONFIRM_PROD !== 'yes'
  ) {
    throw new RosterCommandError(
      `--${mode} against PROD requires SSMS_CONFIRM_PROD=yes.`,
    );
  }
}

/** CLI entry point used by `scripts/import-season-roster.ts`. */
export async function runRosterCli(
  deps: RosterDeps,
  argv: string[],
): Promise<ImportReport | DeliveryReport | ReleaseReport> {
  const options = parseRosterArgs(argv);
  assertProdConfirmed(deps.env, options.mode);
  switch (options.mode) {
    case 'apply':
      return runApply(deps, options);
    case 'send':
      return runSend(deps, options);
    case 'remind':
      return runRemind(deps, options);
    case 'release-stale-claims':
      return runReleaseStaleClaims(deps, options);
    default:
      return runDryRun(deps, options);
  }
}
