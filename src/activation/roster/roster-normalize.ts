export type CertOrg = 'csia' | 'casi';
export type CertTrack = 'regular' | 'park' | 'carving';
export type ValueSource = 'rule' | 'llm';
export type TrainerDiscipline = 'ski' | 'snowboard';

export interface RosterCertification {
  org: CertOrg;
  track: CertTrack;
  level: number;
  isPartial: boolean;
  partialComponents: string[];
}

export interface ProposedCertification extends RosterCertification {
  source: ValueSource;
}

/** An `instructor_trainer_status` row; trainer development means the trainer exam was passed, giving trainer level 1. */
export interface RosterTrainerStatus {
  discipline: TrainerDiscipline;
  rookieSessionCompleted: true;
  trainerExamPassed: true;
  trainerLevel: 1;
}

export interface ProposedTrainerStatus extends RosterTrainerStatus {
  source: ValueSource;
}

export interface CertificationNormalization {
  certifications: ProposedCertification[];
  trainerStatus: ProposedTrainerStatus[];
  unresolved: string[];
  /** True when any value needed more than the canonical `CSIA L3` / `CASI Park 1` form. */
  normalized: boolean;
}

export interface LocationNormalization {
  keys: string[];
  unresolved: string[];
  normalized: boolean;
}

export const CERT_ORGS: readonly CertOrg[] = ['csia', 'casi'];
export const CERT_TRACKS: readonly CertTrack[] = ['regular', 'park', 'carving'];

/** `instructor_certifications.partial_components` vocabulary per org (migration 010). */
export const PARTIAL_COMPONENTS: Record<CertOrg, readonly string[]> = {
  csia: ['ski', 'teach'],
  casi: ['instructor_training', 'riding', 'teaching'],
};

/** Allowed levels per track: migration 010 for regular and park; CASI carving has a single level. */
export const LEVEL_RANGE: Record<CertTrack, readonly [number, number]> = {
  regular: [1, 4],
  park: [1, 2],
  carving: [1, 1],
};

export const TRAINER_DISCIPLINE: Record<CertOrg, TrainerDiscipline> = {
  csia: 'ski',
  casi: 'snowboard',
};

export const LOCATION_KEYS: Record<string, string> = {
  msl: 'teaching_location.moonstone',
  moonstone: 'teaching_location.moonstone',
  'mount st louis': 'teaching_location.moonstone',
  'mount st louis moonstone': 'teaching_location.moonstone',
  'blue mountain': 'teaching_location.blue_mountain',
  'blue mountains': 'teaching_location.blue_mountain',
  'blue mtn': 'teaching_location.blue_mountain',
  bm: 'teaching_location.blue_mountain',
  tremblant: 'teaching_location.tremblant',
  'mont tremblant': 'teaching_location.tremblant',
  'glen eden': 'teaching_location.glen_eden',
};

export const ALLOWED_LOCATION_KEYS: readonly string[] = [
  ...new Set(Object.values(LOCATION_KEYS)),
];

const CANONICAL_LOCATIONS = new Set([
  'msl',
  'blue mountain',
  'tremblant',
  'glen eden',
]);

type GenericComponent = 'ski' | 'teaching' | 'riding' | 'instructor_training';

const COMPONENT_WORDS: Record<string, GenericComponent> = {
  ski: 'ski',
  skiing: 'ski',
  teach: 'teaching',
  teaching: 'teaching',
  ped: 'teaching',
  pedagogy: 'teaching',
  pedagogical: 'teaching',
  riding: 'riding',
  ride: 'riding',
  instructortraining: 'instructor_training',
};

const ORG_COMPONENT: Record<
  CertOrg,
  Partial<Record<GenericComponent, string>>
> = {
  csia: { ski: 'ski', teaching: 'teach' },
  casi: {
    teaching: 'teaching',
    riding: 'riding',
    instructor_training: 'instructor_training',
  },
};

const LEVEL_WORDS = new Set(['l', 'lv', 'lvl', 'lev', 'level']);
const PARK_WORDS = new Set(['park', 'p']);
const CARVING_WORDS = new Set(['carving', 'carve']);
const PARTIAL_WORDS = new Set(['partial', 'partially']);
const TRAINER_DEVELOPMENT = 'td';
const FILLER_WORDS = new Set(['please', 'specify', 'in', 'other', 'and']);
const ROMAN: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4 };
const CANONICAL_CERT = /^(CSIA|CASI)(L[1-4]|PARK[12])$/;

interface Clause {
  org?: CertOrg;
  level?: number;
  park: boolean;
  carving: boolean;
  partial: boolean;
  trainerDevelopment: boolean;
  components: Set<GenericComponent>;
  unknown: string[];
}

type CertValue =
  | { kind: 'full'; cert: RosterCertification }
  | { kind: 'trainer' }
  | { kind: 'partial'; org: CertOrg; level: number }
  | { kind: 'fragment'; clause: Clause }
  | { kind: 'unrecognised' };

interface Marker {
  org: CertOrg;
  level: number;
  components: Set<string>;
  values: string[];
}

export function splitList(value: string): string[] {
  return value
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v !== '');
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/instructor\s*training/g, ' instructortraining ')
    .replace(/\b(?:trainer\s*development|t\s*d)\b/g, ' td ')
    .replace(/\b(csia|casi)/g, ' $1 ')
    .replace(/(\d+)/g, ' $1 ')
    .split(/[^a-z0-9]+/)
    .filter((t) => t !== '');
}

function levelOf(token: string | undefined): number | undefined {
  if (token === undefined) {
    return undefined;
  }
  if (/^\d+$/.test(token)) {
    return Number(token);
  }
  return ROMAN[token];
}

function parseClause(tokens: string[]): Clause {
  const clause: Clause = {
    park: false,
    carving: false,
    partial: false,
    trainerDevelopment: false,
    components: new Set(),
    unknown: [],
  };
  const setOrg = (org: CertOrg) => {
    if (clause.org !== undefined && clause.org !== org) {
      clause.unknown.push(org);
    }
    clause.org = org;
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const next = levelOf(tokens[i + 1]);
    if (token === 'csia' || token === 'casi') {
      setOrg(token);
      if (/^\d+$/.test(tokens[i + 1] ?? '')) {
        clause.level = Number(tokens[i + 1]);
        i++;
      }
    } else if (LEVEL_WORDS.has(token) && next !== undefined) {
      clause.level = next;
      i++;
    } else if (PARK_WORDS.has(token)) {
      clause.park = true;
      if (next !== undefined) {
        clause.level = next;
        i++;
      }
    } else if (CARVING_WORDS.has(token)) {
      clause.carving = true;
    } else if (PARTIAL_WORDS.has(token)) {
      clause.partial = true;
    } else if (token === TRAINER_DEVELOPMENT) {
      clause.trainerDevelopment = true;
    } else if (COMPONENT_WORDS[token] !== undefined) {
      clause.components.add(COMPONENT_WORDS[token]);
    } else if (!FILLER_WORDS.has(token)) {
      clause.unknown.push(token);
    }
  }
  return clause;
}

function inRange(track: CertTrack, level: number | undefined): boolean {
  const [min, max] = LEVEL_RANGE[track];
  return level !== undefined && level >= min && level <= max;
}

function full(
  org: CertOrg,
  track: CertTrack,
  level: number,
): RosterCertification {
  return { org, track, level, isPartial: false, partialComponents: [] };
}

function classify(value: string): CertValue {
  const clause = parseClause(tokenize(value));
  const { org, level } = clause;
  if (clause.unknown.length > 0) {
    return { kind: 'unrecognised' };
  }
  if (clause.trainerDevelopment) {
    const onlyOrg =
      level === undefined &&
      !clause.park &&
      !clause.carving &&
      !clause.partial &&
      clause.components.size === 0;
    return onlyOrg ? { kind: 'trainer' } : { kind: 'unrecognised' };
  }
  if (clause.components.size > 0) {
    return clause.park || clause.carving
      ? { kind: 'unrecognised' }
      : { kind: 'fragment', clause };
  }
  if (org === undefined) {
    return { kind: 'unrecognised' };
  }
  if (clause.partial) {
    return !clause.park && !clause.carving && inRange('regular', level)
      ? { kind: 'partial', org, level: level as number }
      : { kind: 'unrecognised' };
  }
  if (clause.carving) {
    const carvingLevel = level ?? LEVEL_RANGE.carving[0];
    return org === 'casi' && !clause.park && inRange('carving', carvingLevel)
      ? { kind: 'full', cert: full(org, 'carving', carvingLevel) }
      : { kind: 'unrecognised' };
  }
  const track: CertTrack = clause.park ? 'park' : 'regular';
  return inRange(track, level)
    ? { kind: 'full', cert: full(org, track, level as number) }
    : { kind: 'unrecognised' };
}

function detailClauses(details: string): Clause[] {
  const clauses: string[][] = [[]];
  for (const token of tokenize(details)) {
    if ((token === 'csia' || token === 'casi') && clauses[0].length > 0) {
      clauses.unshift([]);
    }
    clauses[0].push(token);
  }
  return clauses
    .map(parseClause)
    .filter(
      (c) =>
        c.components.size > 0 && c.level !== undefined && !c.park && !c.carving,
    );
}

function orgComponents(
  org: CertOrg,
  components: Set<GenericComponent>,
): string[] | null {
  const mapped = [...components].map((c) => ORG_COMPONENT[org][c]);
  const known = mapped.filter((c): c is string => c !== undefined);
  return known.length === mapped.length ? known : null;
}

function attach(markers: Marker[], clause: Clause): boolean {
  const candidates = markers.filter(
    (m) =>
      (clause.org === undefined || m.org === clause.org) &&
      (clause.level === undefined || m.level === clause.level),
  );
  if (candidates.length !== 1) {
    return false;
  }
  const [marker] = candidates;
  const components = orgComponents(marker.org, clause.components);
  if (components === null) {
    return false;
  }
  components.forEach((c) => marker.components.add(c));
  return true;
}

function markerFor(markers: Marker[], org: CertOrg, level: number): Marker {
  const existing = markers.find((m) => m.org === org && m.level === level);
  if (existing) {
    return existing;
  }
  const marker: Marker = { org, level, components: new Set(), values: [] };
  markers.push(marker);
  return marker;
}

function sortComponents(org: CertOrg, components: Iterable<string>): string[] {
  const set = new Set(components);
  return PARTIAL_COMPONENTS[org].filter((c) => set.has(c));
}

function partialOrFull(
  org: CertOrg,
  level: number,
  components: Iterable<string>,
): RosterCertification {
  const sorted = sortComponents(org, components);
  return sorted.length === PARTIAL_COMPONENTS[org].length
    ? full(org, 'regular', level)
    : {
        org,
        track: 'regular',
        level,
        isPartial: true,
        partialComponents: sorted,
      };
}

function outranks(
  a: RosterCertification,
  b: RosterCertification,
): boolean | null {
  if (a.level !== b.level) {
    return a.level > b.level;
  }
  if (a.isPartial !== b.isPartial) {
    return !a.isPartial;
  }
  return null;
}

function statedOrgs(values: string[]): Set<CertOrg> {
  return new Set(
    values
      .flatMap((v) => tokenize(v))
      .filter((t): t is CertOrg => CERT_ORGS.includes(t as CertOrg)),
  );
}

/**
 * The discipline a trainer-development `value` in the certification `cell`
 * stands for: the org named in the value itself, else the cell's only stated
 * org. Null when neither settles it.
 */
export function trainerDisciplineFor(
  value: string,
  cell: string,
): TrainerDiscipline | null {
  const valueOrgs = statedOrgs([value]);
  const orgs = valueOrgs.size > 0 ? valueOrgs : statedOrgs(splitList(cell));
  return orgs.size === 1 ? TRAINER_DISCIPLINE[[...orgs][0]] : null;
}

function trainerStatusFor(discipline: TrainerDiscipline): RosterTrainerStatus {
  return {
    discipline,
    rookieSessionCompleted: true,
    trainerExamPassed: true,
    trainerLevel: 1,
  };
}

/** One entry per discipline; a rule-derived entry is kept over an LLM one. */
export function mergeTrainerStatus(
  statuses: ProposedTrainerStatus[],
): ProposedTrainerStatus[] {
  const best = new Map<TrainerDiscipline, ProposedTrainerStatus>();
  for (const status of statuses) {
    const current = best.get(status.discipline);
    if (!current || (current.source === 'llm' && status.source === 'rule')) {
      best.set(status.discipline, status);
    }
  }
  return [...best.values()];
}

/** Highest-only per (org, track); the precedence is specified in roster-normalize.spec.ts. */
export function keepHighest(
  certs: ProposedCertification[],
): ProposedCertification[] {
  const best = new Map<string, ProposedCertification>();
  for (const cert of certs) {
    const key = `${cert.org}:${cert.track}`;
    const current = best.get(key);
    if (!current) {
      best.set(key, cert);
      continue;
    }
    const wins = outranks(cert, current);
    if (wins === true) {
      best.set(key, cert);
    } else if (wins === null && cert.isPartial) {
      const merged = partialOrFull(cert.org, cert.level, [
        ...current.partialComponents,
        ...cert.partialComponents,
      ]);
      const source =
        current.source === 'llm' || cert.source === 'llm' ? 'llm' : 'rule';
      best.set(key, { ...merged, source });
    } else if (wins === null && current.source === 'llm') {
      best.set(key, cert);
    }
  }
  return [...best.values()];
}

/**
 * Normalises one row's certification cell (comma-joined multi-select plus
 * "Other" fragments) using the "when and where" text for partial components.
 */
export function normalizeCertifications(
  cell: string,
  details = '',
): CertificationNormalization {
  const values = splitList(cell);
  const certs: ProposedCertification[] = [];
  const markers: Marker[] = [];
  const fragments: { value: string; clause: Clause }[] = [];
  const trainerStatus: ProposedTrainerStatus[] = [];
  const unresolved: string[] = [];
  let normalized = false;
  for (const value of values) {
    if (!CANONICAL_CERT.test(value.toUpperCase().replace(/\s+/g, ''))) {
      normalized = true;
    }
    const parsed = classify(value);
    if (parsed.kind === 'full') {
      certs.push({ ...parsed.cert, source: 'rule' });
    } else if (parsed.kind === 'trainer') {
      const discipline = trainerDisciplineFor(value, cell);
      if (discipline === null) {
        unresolved.push(value);
      } else {
        trainerStatus.push({ ...trainerStatusFor(discipline), source: 'rule' });
      }
    } else if (parsed.kind === 'partial') {
      markerFor(markers, parsed.org, parsed.level).values.push(value);
    } else if (parsed.kind === 'fragment') {
      fragments.push({ value, clause: parsed.clause });
    } else {
      unresolved.push(value);
    }
  }
  const selfNamed = fragments.filter(
    (f) => f.clause.org !== undefined && f.clause.level !== undefined,
  );
  for (const { clause } of selfNamed) {
    if (inRange('regular', clause.level)) {
      markerFor(markers, clause.org as CertOrg, clause.level as number);
    }
  }
  const ordered = [
    ...selfNamed,
    ...fragments.filter((f) => !selfNamed.includes(f)),
  ];
  for (const { value, clause } of ordered) {
    if (!attach(markers, clause)) {
      unresolved.push(value);
    }
  }
  if (markers.length > 0) {
    for (const clause of detailClauses(details)) {
      attach(markers, clause);
    }
  }
  for (const marker of markers) {
    certs.push({
      ...partialOrFull(marker.org, marker.level, marker.components),
      source: 'rule',
    });
  }
  return {
    certifications: keepHighest(certs),
    trainerStatus: mergeTrainerStatus(trainerStatus),
    unresolved: values.filter((v) => unresolved.includes(v)),
    normalized,
  };
}

function locationLookupKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(saint|st)\b/g, 'st')
    .replace(/\b(mt|mont)\b(?= st)/g, 'mount')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Maps a comma-separated location cell onto `teaching_locations.key` values. */
export function normalizeLocations(cell: string): LocationNormalization {
  const keys: string[] = [];
  const unresolved: string[] = [];
  let normalized = false;
  for (const value of splitList(cell)) {
    const lookup = locationLookupKey(value);
    if (
      !CANONICAL_LOCATIONS.has(value.trim().replace(/\s+/g, ' ').toLowerCase())
    ) {
      normalized = true;
    }
    const key = LOCATION_KEYS[lookup];
    if (key === undefined) {
      unresolved.push(value);
    } else if (!keys.includes(key)) {
      keys.push(key);
    }
  }
  return { keys, unresolved, normalized };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Returns `value` as a certification when it satisfies every
 * `instructor_certifications` constraint (migration 010), else null.
 */
export function validateCertification(
  value: unknown,
): RosterCertification | null {
  if (!isRecord(value)) {
    return null;
  }
  const { org, track, level, isPartial, partialComponents } = value;
  if (
    !CERT_ORGS.includes(org as CertOrg) ||
    !CERT_TRACKS.includes(track as CertTrack) ||
    typeof level !== 'number' ||
    !Number.isInteger(level) ||
    !inRange(track as CertTrack, level) ||
    typeof isPartial !== 'boolean' ||
    !Array.isArray(partialComponents) ||
    !partialComponents.every((c) => typeof c === 'string')
  ) {
    return null;
  }
  const certOrg = org as CertOrg;
  const certTrack = track as CertTrack;
  const components = partialComponents;
  if (certTrack === 'carving' && certOrg !== 'casi') {
    return null;
  }
  if (isPartial && certTrack !== 'regular') {
    return null;
  }
  if (!isPartial && components.length > 0) {
    return null;
  }
  if (
    new Set(components).size !== components.length ||
    !components.every((c) => PARTIAL_COMPONENTS[certOrg].includes(c))
  ) {
    return null;
  }
  return isPartial
    ? partialOrFull(certOrg, level, components)
    : full(certOrg, certTrack, level);
}

/**
 * Returns `value` as a trainer-development status when it is exactly trainer
 * level 1 after the rookie session (migration 011) in `allowedDiscipline`.
 */
export function validateTrainerStatus(
  value: unknown,
  allowedDiscipline: TrainerDiscipline | null,
): RosterTrainerStatus | null {
  if (!isRecord(value)) {
    return null;
  }
  const {
    discipline,
    rookieSessionCompleted,
    trainerExamPassed,
    trainerLevel,
  } = value;
  return allowedDiscipline !== null &&
    discipline === allowedDiscipline &&
    rookieSessionCompleted === true &&
    trainerExamPassed === true &&
    trainerLevel === 1
    ? trainerStatusFor(allowedDiscipline)
    : null;
}

const DISCIPLINE_LABEL: Record<TrainerDiscipline, string> = {
  ski: 'Ski',
  snowboard: 'Snowboard',
};

/** `Ski Trainer Level 1 (trainer development)` for the review report. */
export function describeTrainerStatus(status: RosterTrainerStatus): string {
  return `${DISCIPLINE_LABEL[status.discipline]} Trainer Level ${status.trainerLevel} (trainer development)`;
}

const ORG_LABEL: Record<CertOrg, string> = { csia: 'CSIA', casi: 'CASI' };

/** `CASI Level 3 Partial [riding]`, `CSIA Park Level 1`, … for the review report. */
export function describeCertification(cert: RosterCertification): string {
  const track =
    cert.track === 'park'
      ? 'Park '
      : cert.track === 'carving'
        ? 'Carving '
        : '';
  const partial = cert.isPartial
    ? ` Partial [${cert.partialComponents.join(', ')}]`
    : '';
  return `${ORG_LABEL[cert.org]} ${track}Level ${cert.level}${partial}`;
}
