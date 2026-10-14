import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EmailDeliveryError } from '../../mailer/mailer.types';
import type { InviteRecipient } from '../activation.types';
import type { InviteDispatcher } from '../invite-dispatcher';
import type { InvitesRepository } from '../invites.repository';
import { rosterCsv } from './roster-fixtures.test-util';
import {
  DEFAULT_SEASON,
  NO_REFERENCE_ROW,
  RosterCommandError,
  SEND_INTERVAL_MS,
  assertOutsideRepo,
  assertProdConfirmed,
  inviteIdempotencyKey,
  parseRosterArgs,
  runRosterCli,
  type DeliveryReport,
  type ImportReport,
  type ReleaseReport,
  type RosterDeps,
} from './roster-import';
import type { RosterLlmNormalizer, RosterLlmRequest } from './roster-llm';
import type {
  ExistingAuthUser,
  RosterReader,
  RosterWriter,
} from './roster-ports';

function full(org: string, track: string, level: number) {
  return {
    org,
    track,
    level,
    isPartial: false,
    partialComponents: [],
    source: 'rule',
  };
}

const NOW = new Date('2026-10-11T04:00:00Z');
const SEASON = DEFAULT_SEASON;

const LOCATION_IDS = new Map([
  ['teaching_location.moonstone', 'loc-msl'],
  ['teaching_location.blue_mountain', 'loc-bm'],
]);

const CSV = rosterCsv([
  {
    preferred: 'Avery',
    certs: 'CSIA L2, CSIA L3, Mystery cert',
    locations: 'MSL, Glen Eden, Shanghai',
    legal: 'Avery Legalname',
    dob: '3/4/1995',
    email: 'avery@example.test',
  },
  { preferred: 'Blake', email: 'blake@example.test', dob: '2/30/1990' },
  { preferred: 'Casey', email: 'casey@example.test', certs: 'CASI Park 1' },
  { preferred: 'Dana', email: 'dana@example.test', locations: 'Blue Mountain' },
  { email: 'bad-email' },
]);

function invite(overrides: Partial<InviteRecipient> = {}): InviteRecipient {
  return {
    id: 'inv-1',
    instructor_id: 'ins-1',
    auth_user_id: 'auth-1',
    email: 'avery@example.test',
    token_hash: null,
    season: SEASON,
    expires_at: null,
    send_claimed_at: null,
    sent_at: null,
    remind_claimed_at: null,
    reminded_at: null,
    redeemed_at: null,
    activated_at: null,
    created_at: '2026-10-01T00:00:00Z',
    display_name_en: 'Avery',
    preferred_language: 'zh-CN',
    ...overrides,
  };
}

interface Harness {
  deps: RosterDeps;
  reader: jest.Mocked<RosterReader>;
  readUsers: jest.Mock;
  writer: jest.Mocked<RosterWriter>;
  invites: jest.Mocked<
    Pick<
      InvitesRepository,
      | 'listUnsent'
      | 'listDueForReminder'
      | 'markSent'
      | 'markReminded'
      | 'claim'
      | 'releaseClaim'
      | 'listUnfinishedClaims'
      | 'releaseStaleClaims'
    >
  >;
  dispatch: jest.Mock;
  factories: { writer: jest.Mock; invites: jest.Mock; dispatcher: jest.Mock };
  logs: string[];
  written: Map<string, string>;
  sleep: jest.Mock;
}

function harness(
  users: Map<string, ExistingAuthUser> = new Map(),
  env: Record<string, string | undefined> = { SSMS_ENV: 'dev' },
): Harness {
  const readUsers = jest.fn().mockResolvedValue(users);
  const reader: jest.Mocked<RosterReader> = {
    authUsersByEmail: readUsers,
    teachingLocationIds: jest.fn((keys: string[]) =>
      Promise.resolve(
        new Map([...LOCATION_IDS].filter(([k]) => keys.includes(k))),
      ),
    ),
  };
  let n = 0;
  const writer: jest.Mocked<RosterWriter> = {
    createUser: jest.fn(() => Promise.resolve(`auth-new-${++n}`)),
    findInstructorId: jest.fn().mockResolvedValue(null),
    insertInstructor: jest.fn((i: { authUserId: string }) =>
      Promise.resolve(`ins-for-${i.authUserId}`),
    ),
    hasProfileRelations: jest.fn().mockResolvedValue(true),
    setProfileRelations: jest.fn().mockResolvedValue(undefined),
    insertInvite: jest.fn().mockResolvedValue(true),
  };
  const invites = {
    listUnsent: jest.fn().mockResolvedValue([]),
    listDueForReminder: jest.fn().mockResolvedValue([]),
    markSent: jest.fn().mockResolvedValue(undefined),
    markReminded: jest.fn().mockResolvedValue(undefined),
    claim: jest.fn().mockResolvedValue(true),
    releaseClaim: jest.fn().mockResolvedValue(undefined),
    listUnfinishedClaims: jest.fn().mockResolvedValue([]),
    releaseStaleClaims: jest.fn().mockResolvedValue([]),
  };
  const dispatch = jest.fn().mockResolvedValue('sent');
  const factories = {
    writer: jest.fn(() => writer),
    invites: jest.fn(() => invites as unknown as InvitesRepository),
    dispatcher: jest.fn(() => ({ dispatch }) as unknown as InviteDispatcher),
  };
  const logs: string[] = [];
  const written = new Map<string, string>();
  const sleep = jest.fn().mockResolvedValue(undefined);
  const deps: RosterDeps = {
    reader: () => reader,
    writer: factories.writer,
    invites: factories.invites,
    dispatcher: factories.dispatcher,
    readFile: jest.fn().mockResolvedValue(CSV),
    writeFile: jest.fn((file: string, contents: string) => {
      written.set(file, contents);
      return Promise.resolve();
    }),
    sleep,
    log: (line) => logs.push(line),
    now: () => NOW,
    repoRoot: path.resolve(__dirname, '../../..'),
    env,
  };
  return {
    deps,
    reader,
    readUsers,
    writer,
    invites,
    dispatch,
    factories,
    logs,
    written,
    sleep,
  };
}

const OUTSIDE = path.join(os.tmpdir(), 'roster-report.json');
const OUTSIDE_RESOLVED = path.join(
  fs.realpathSync(os.tmpdir()),
  'roster-report.json',
);

describe('parseRosterArgs', () => {
  it('defaults to dry-run and season 2026/27', () => {
    expect(parseRosterArgs(['--csv', 'a.csv'])).toEqual({
      mode: 'dry-run',
      csv: 'a.csv',
      season: '2026/27',
      only: undefined,
      report: undefined,
      normalizeWithLlm: false,
    });
  });

  it('reads every flag', () => {
    expect(
      parseRosterArgs([
        '--send',
        '--only',
        ' Avery@Example.test ',
        '--report',
        'r.json',
        '--season',
        '2027/28',
      ]),
    ).toEqual({
      mode: 'send',
      csv: undefined,
      season: '2027/28',
      only: 'avery@example.test',
      report: 'r.json',
      normalizeWithLlm: false,
    });
    expect(parseRosterArgs(['--remind']).mode).toBe('remind');
    expect(
      parseRosterArgs(['--release-stale-claims', '45', '--season', '2027/28']),
    ).toEqual({
      mode: 'release-stale-claims',
      csv: undefined,
      season: '2027/28',
      only: undefined,
      report: undefined,
      staleClaimMinutes: 45,
      normalizeWithLlm: false,
    });
    expect(parseRosterArgs(['--apply', '--csv', 'a.csv']).mode).toBe('apply');
    expect(parseRosterArgs(['--dry-run', '--csv', 'a.csv']).mode).toBe(
      'dry-run',
    );
  });

  it.each([
    [['--apply', '--send', '--csv', 'a'], /Pick one mode/],
    [['--apply'], /--csv is required for apply/],
    [[], /--csv is required for dry-run/],
    [['--remind', '--only', 'a@b.c'], /--only works with --send only/],
    [['--csv'], /Unexpected argument --csv/],
    [['--csv', '--apply'], /Unexpected argument --csv/],
    [['--bogus'], /Unexpected argument --bogus/],
    [['--release-stale-claims', '0'], /whole number of minutes/],
    [['--release-stale-claims', '1.5'], /whole number of minutes/],
    [['--release-stale-claims', 'ten'], /whole number of minutes/],
    [['--send', '--release-stale-claims', '5'], /Pick one mode/],
  ])('rejects %j', (argv, message) => {
    expect(() => parseRosterArgs(argv)).toThrow(message);
  });
});

describe('assertOutsideRepo', () => {
  const repo = path.resolve(__dirname, '../../..');

  it('refuses paths inside the repository', () => {
    expect(() =>
      assertOutsideRepo(repo, path.join(repo, 'report.json')),
    ).toThrow(RosterCommandError);
    expect(() =>
      assertOutsideRepo(repo, path.join(repo, 'no/such/dir/r.json')),
    ).toThrow(/inside the repository/);
  });

  it('accepts paths outside it', () => {
    expect(assertOutsideRepo(repo, OUTSIDE)).toBe(
      path.join(fs.realpathSync(os.tmpdir()), 'roster-report.json'),
    );
  });
});

describe('assertProdConfirmed', () => {
  it('needs SSMS_CONFIRM_PROD=yes for writing modes against prod', () => {
    expect(() => assertProdConfirmed({ SSMS_ENV: 'prod' }, 'apply')).toThrow(
      /--apply against PROD requires SSMS_CONFIRM_PROD=yes/,
    );
    expect(() =>
      assertProdConfirmed({ SSMS_ENV: 'prod' }, 'dry-run'),
    ).not.toThrow();
    expect(() =>
      assertProdConfirmed(
        { SSMS_ENV: 'prod', SSMS_CONFIRM_PROD: 'yes' },
        'send',
      ),
    ).not.toThrow();
    expect(() =>
      assertProdConfirmed({ SSMS_ENV: 'dev' }, 'remind'),
    ).not.toThrow();
  });
});

describe('runRosterCli --dry-run', () => {
  it('reports counts, unmapped values and existing users without any write', async () => {
    const h = harness(
      new Map([
        ['dana@example.test', { id: 'auth-dana', importedSeason: null }],
      ]),
    );
    const report = (await runRosterCli(h.deps, [
      '--csv',
      'roster.csv',
      '--report',
      OUTSIDE,
    ])) as ImportReport;

    expect(h.factories.writer).not.toHaveBeenCalled();
    expect(h.factories.invites).not.toHaveBeenCalled();
    expect(h.factories.dispatcher).not.toHaveBeenCalled();

    expect(report.counts).toMatchObject({
      csvRows: 5,
      uniqueEmails: 4,
      invalidEmail: 1,
      toCreate: 3,
      existingUsers: 1,
      dateOfBirthInvalid: 1,
      dateOfBirthMissing: 2,
      rowsWithUnmappedCertifications: 1,
      rowsWithUnmappedLocations: 1,
      rowsWithoutCertification: 2,
    });
    expect(report.unmappedValues).toEqual({
      certifications: { 'Mystery cert': 1 },
      locations: {
        Shanghai: 1,
        'teaching_location.glen_eden (key not in database)': 1,
      },
    });
    expect(report.existingUsers).toEqual(['dana@example.test']);
    expect(report.rows[0]).toMatchObject({ certifications: 1, locations: 1 });

    const json = h.written.get(OUTSIDE_RESOLVED) as string;
    expect(JSON.parse(json)).toMatchObject({ mode: 'dry-run', env: 'dev' });
    const output = `${json}\n${h.logs.join('\n')}`;
    for (const secret of [
      'Legalname',
      '1995',
      '555-0100',
      'Fake Street',
      '000000000',
    ]) {
      expect(output).not.toContain(secret);
    }
    expect(h.logs).toContain('  "Mystery cert" × 1');
    expect(h.logs).toContain('Already in auth.users (skipped):');
  });

  it('refuses a report path inside the repo before reading anything', async () => {
    const h = harness();
    await expect(
      runRosterCli(h.deps, ['--csv', 'roster.csv', '--report', 'report.json']),
    ).rejects.toThrow(/inside the repository/);
    expect(h.readUsers).not.toHaveBeenCalled();
  });

  it('works without a report file', async () => {
    const h = harness();
    await runRosterCli(h.deps, ['--csv', 'roster.csv']);
    expect(h.deps.writeFile).not.toHaveBeenCalled();
  });
});

describe('runRosterCli --apply', () => {
  it('creates users, pending instructors, relations and unsent invites; skips existing users', async () => {
    const h = harness(
      new Map([
        ['dana@example.test', { id: 'auth-dana', importedSeason: null }],
        ['casey@example.test', { id: 'auth-casey', importedSeason: SEASON }],
      ]),
    );
    h.writer.findInstructorId.mockImplementation((id: string) =>
      Promise.resolve(id === 'auth-casey' ? 'ins-casey' : null),
    );
    h.writer.insertInvite.mockImplementation((i) =>
      Promise.resolve(i.auth_user_id !== 'auth-casey'),
    );

    const report = (await runRosterCli(h.deps, [
      '--apply',
      '--csv',
      'roster.csv',
      '--report',
      OUTSIDE,
    ])) as ImportReport;

    expect(h.writer.createUser.mock.calls).toEqual([
      ['avery@example.test', SEASON],
      ['blake@example.test', SEASON],
    ]);
    expect(h.writer.insertInstructor.mock.calls).toEqual([
      [
        {
          authUserId: 'auth-new-1',
          email: 'avery@example.test',
          displayNameEn: 'Avery',
          dateOfBirth: '1995-03-04',
        },
      ],
      [
        {
          authUserId: 'auth-new-2',
          email: 'blake@example.test',
          displayNameEn: 'Blake',
          dateOfBirth: null,
        },
      ],
    ]);
    expect(h.writer.setProfileRelations.mock.calls).toEqual([
      ['ins-for-auth-new-1', [full('csia', 'regular', 3)], ['loc-msl'], []],
    ]);
    expect(h.writer.insertInvite.mock.calls).toEqual([
      [
        {
          instructor_id: 'ins-for-auth-new-1',
          auth_user_id: 'auth-new-1',
          email: 'avery@example.test',
          season: SEASON,
        },
      ],
      [
        {
          instructor_id: 'ins-for-auth-new-2',
          auth_user_id: 'auth-new-2',
          email: 'blake@example.test',
          season: SEASON,
        },
      ],
      [
        {
          instructor_id: 'ins-casey',
          auth_user_id: 'auth-casey',
          email: 'casey@example.test',
          season: SEASON,
        },
      ],
    ]);
    expect(report.rows.map((r) => [r.email, r.status])).toEqual([
      ['avery@example.test', 'created'],
      ['blake@example.test', 'created'],
      ['casey@example.test', 'already_imported'],
      ['dana@example.test', 'existing_user'],
    ]);
    expect(report.counts).toMatchObject({
      created: 2,
      alreadyImported: 1,
      existingUsers: 1,
      failed: 0,
    });
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('resumes a user this import created whose instructor row is missing', async () => {
    const h = harness(
      new Map([
        ['casey@example.test', { id: 'auth-casey', importedSeason: SEASON }],
      ]),
    );
    const report = (await runRosterCli(h.deps, [
      '--apply',
      '--csv',
      'roster.csv',
    ])) as ImportReport;
    expect(
      report.rows.find((r) => r.email === 'casey@example.test')?.status,
    ).toBe('resumed');
    expect(h.writer.setProfileRelations.mock.calls).toContainEqual([
      'ins-for-auth-casey',
      [full('casi', 'park', 1)],
      [],
      [],
    ]);
  });

  describe('rerun for a user this import created whose instructor exists', () => {
    const casey = new Map([
      ['casey@example.test', { id: 'auth-casey', importedSeason: SEASON }],
    ]);
    const caseyInvite = {
      instructor_id: 'ins-casey',
      auth_user_id: 'auth-casey',
      email: 'casey@example.test',
      season: SEASON,
    };

    async function rerun(hasRelations: boolean, inviteCreated: boolean) {
      const h = harness(casey);
      h.writer.findInstructorId.mockImplementation((id: string) =>
        Promise.resolve(id === 'auth-casey' ? 'ins-casey' : null),
      );
      h.writer.hasProfileRelations.mockResolvedValue(hasRelations);
      h.writer.insertInvite.mockImplementation((i) =>
        Promise.resolve(i.auth_user_id === 'auth-casey' ? inviteCreated : true),
      );
      const report = (await runRosterCli(h.deps, [
        '--apply',
        '--csv',
        'roster.csv',
      ])) as ImportReport;
      const row = report.rows.find((r) => r.email === 'casey@example.test');
      return { h, report, status: row?.status };
    }

    it('writes certifications and locations the crashed run never wrote', async () => {
      const { h, report, status } = await rerun(false, false);
      expect(h.writer.hasProfileRelations.mock.calls).toContainEqual([
        'ins-casey',
      ]);
      expect(
        h.writer.insertInstructor.mock.calls.map(([i]) => i.authUserId),
      ).not.toContain('auth-casey');
      expect(h.writer.setProfileRelations.mock.calls).toContainEqual([
        'ins-casey',
        [full('casi', 'park', 1)],
        [],
        [],
      ]);
      expect(status).toBe('repaired');
      expect(report.counts).toMatchObject({ repaired: 1, alreadyImported: 0 });
    });

    it('leaves existing certifications and locations untouched', async () => {
      const { h, status } = await rerun(true, false);
      expect(
        h.writer.setProfileRelations.mock.calls.map(([id]) => id),
      ).not.toContain('ins-casey');
      expect(status).toBe('already_imported');
    });

    it('creates a missing invite row', async () => {
      const { h, status } = await rerun(true, true);
      expect(h.writer.insertInvite.mock.calls).toContainEqual([caseyInvite]);
      expect(
        h.writer.setProfileRelations.mock.calls.map(([id]) => id),
      ).not.toContain('ins-casey');
      expect(status).toBe('repaired');
    });

    it('does not look for relations when the row has none to write', async () => {
      const h = harness(
        new Map([
          ['blake@example.test', { id: 'auth-blake', importedSeason: SEASON }],
        ]),
      );
      h.writer.findInstructorId.mockImplementation((id: string) =>
        Promise.resolve(id === 'auth-blake' ? 'ins-blake' : null),
      );
      h.writer.insertInvite.mockResolvedValue(false);
      const report = (await runRosterCli(h.deps, [
        '--apply',
        '--csv',
        'roster.csv',
      ])) as ImportReport;
      expect(h.writer.hasProfileRelations.mock.calls).not.toContainEqual([
        'ins-blake',
      ]);
      expect(
        report.rows.find((r) => r.email === 'blake@example.test')?.status,
      ).toBe('already_imported');
    });
  });

  it('records a failing row and carries on', async () => {
    const h = harness();
    h.writer.createUser.mockRejectedValueOnce(new Error('boom'));
    const report = (await runRosterCli(h.deps, [
      '--apply',
      '--csv',
      'roster.csv',
    ])) as ImportReport;
    expect(report.rows[0]).toMatchObject({ status: 'failed', error: 'boom' });
    expect(report.counts.failed).toBe(1);
    expect(report.counts.created).toBe(3);
    expect(h.logs).toContain('  line 2 failed: boom');
  });

  it('stringifies non-Error failures', async () => {
    const h = harness();
    h.writer.createUser.mockRejectedValueOnce('nope');
    const report = (await runRosterCli(h.deps, [
      '--apply',
      '--csv',
      'roster.csv',
    ])) as ImportReport;
    expect(report.rows[0].error).toBe('nope');
  });

  it('refuses an in-repo report path before writing', async () => {
    const h = harness();
    await expect(
      runRosterCli(h.deps, ['--apply', '--csv', 'r.csv', '--report', 'x.json']),
    ).rejects.toThrow(RosterCommandError);
    expect(h.factories.writer).not.toHaveBeenCalled();
  });

  it('refuses prod without confirmation', async () => {
    const h = harness(new Map(), { SSMS_ENV: 'prod' });
    await expect(
      runRosterCli(h.deps, ['--apply', '--csv', 'r.csv']),
    ).rejects.toThrow(/SSMS_CONFIRM_PROD/);
    expect(h.readUsers).not.toHaveBeenCalled();
  });
});

describe('runRosterCli --send', () => {
  const KEY_1 = inviteIdempotencyKey('inv-1', 'send', NOW);
  const KEY_2 = inviteIdempotencyKey('inv-2', 'send', NOW);

  it('claims, sends invite.season to each unsent invite, spaced ≥ 500 ms, and marks it sent', async () => {
    const h = harness();
    const a = invite();
    const b = invite({ id: 'inv-2', email: 'blake@example.test' });
    h.invites.listUnsent.mockResolvedValue([a, b]);

    const report = (await runRosterCli(h.deps, [
      '--send',
      '--report',
      OUTSIDE,
    ])) as DeliveryReport;

    expect(h.invites.listUnsent).toHaveBeenCalledWith(SEASON, undefined);
    expect(h.invites.claim.mock.calls).toEqual([
      ['inv-1', 'send', NOW],
      ['inv-2', 'send', NOW],
    ]);
    expect(h.dispatch.mock.calls).toEqual([
      [a, 'invite.season', 'sync', NOW, KEY_1],
      [b, 'invite.season', 'sync', NOW, KEY_2],
    ]);
    expect(KEY_1).toBe('invite-inv-1-sent-2026-10-11T04:00:00.000Z');
    expect(h.sleep.mock.calls).toEqual([[SEND_INTERVAL_MS]]);
    expect(SEND_INTERVAL_MS).toBeGreaterThanOrEqual(500);
    expect(h.invites.markSent.mock.calls).toEqual([
      ['inv-1', NOW],
      ['inv-2', NOW],
    ]);
    const [claimOrder] = h.invites.claim.mock.invocationCallOrder;
    const [dispatchOrder] = h.dispatch.mock.invocationCallOrder;
    const [markOrder] = h.invites.markSent.mock.invocationCallOrder;
    expect(claimOrder).toBeLessThan(dispatchOrder);
    expect(dispatchOrder).toBeLessThan(markOrder);
    expect(h.invites.releaseClaim).not.toHaveBeenCalled();
    expect(report.counts).toEqual({
      candidates: 2,
      sent: 2,
      failed: 0,
      skipped: 0,
      needsReview: 0,
    });
    expect(report.needsReview).toEqual([]);
    expect(h.factories.writer).not.toHaveBeenCalled();
  });

  it('restricts to --only and releases the claim when the send fails', async () => {
    const h = harness();
    h.invites.listUnsent.mockResolvedValue([invite()]);
    h.dispatch.mockRejectedValueOnce(
      new EmailDeliveryError('failed', 'resend down'),
    );
    const report = (await runRosterCli(h.deps, [
      '--send',
      '--only',
      'Avery@example.test',
    ])) as DeliveryReport;
    expect(h.invites.listUnsent).toHaveBeenCalledWith(
      SEASON,
      'avery@example.test',
    );
    expect(h.invites.markSent).not.toHaveBeenCalled();
    expect(h.invites.releaseClaim).toHaveBeenCalledWith('inv-1', 'send', NOW);
    expect(report.failed).toEqual([
      { email: 'avery@example.test', error: 'failed: resend down' },
    ]);
    expect(report.needsReview).toEqual([]);
  });

  it('reports non-delivery errors too', async () => {
    const h = harness();
    h.invites.listUnsent.mockResolvedValue([invite()]);
    h.dispatch.mockRejectedValueOnce(new Error('db down'));
    const report = (await runRosterCli(h.deps, ['--send'])) as DeliveryReport;
    expect(report.failed[0].error).toBe('db down');
    expect(h.invites.releaseClaim).toHaveBeenCalledWith('inv-1', 'send', NOW);
  });

  it('does not send an invite another run claimed first', async () => {
    const h = harness();
    h.invites.listUnsent.mockResolvedValue([invite()]);
    h.invites.claim.mockResolvedValueOnce(false);
    const report = (await runRosterCli(h.deps, ['--send'])) as DeliveryReport;
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(report.counts).toMatchObject({ sent: 0, skipped: 1, failed: 0 });
    expect(h.logs).toContain('  skipped invite inv-1: claimed by another run');
  });

  it('does not send when the claim itself fails', async () => {
    const h = harness();
    h.invites.listUnsent.mockResolvedValue([invite()]);
    h.invites.claim.mockRejectedValueOnce(new Error('db down'));
    const report = (await runRosterCli(h.deps, ['--send'])) as DeliveryReport;
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.invites.releaseClaim).not.toHaveBeenCalled();
    expect(report.failed).toEqual([
      { email: 'avery@example.test', error: 'db down' },
    ]);
  });

  it('lists invites left claimed by a crashed run by id only, without resending them', async () => {
    const h = harness();
    h.invites.listUnfinishedClaims.mockResolvedValue(['inv-stale']);
    h.invites.listUnsent.mockResolvedValue([]);
    const report = (await runRosterCli(h.deps, [
      '--send',
      '--report',
      OUTSIDE,
    ])) as DeliveryReport;
    expect(h.invites.listUnfinishedClaims).toHaveBeenCalledWith(SEASON, 'send');
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(report.needsReview).toEqual(['inv-stale']);
    expect(report.counts.needsReview).toBe(1);
    expect(h.logs).toContain(
      'Needs review: claimed but never marked sent, so not sent again: inv-stale',
    );
    expect(h.logs.some((l) => l.includes('--release-stale-claims <N>'))).toBe(
      true,
    );
    const written = JSON.parse(h.written.get(OUTSIDE_RESOLVED) as string) as {
      needsReview: unknown;
    };
    expect(written.needsReview).toEqual(['inv-stale']);
  });

  it('keeps the claim and flags the invite when it was sent but not marked', async () => {
    const h = harness();
    h.invites.listUnsent.mockResolvedValue([invite()]);
    h.invites.markSent.mockRejectedValueOnce(new Error('db down'));
    const report = (await runRosterCli(h.deps, ['--send'])) as DeliveryReport;
    expect(h.invites.releaseClaim).not.toHaveBeenCalled();
    expect(report.counts).toMatchObject({ sent: 0, needsReview: 1 });
    expect(report.needsReview).toEqual(['inv-1']);
  });

  it('flags the invite when a failed send cannot release its claim', async () => {
    const h = harness();
    h.invites.listUnsent.mockResolvedValue([invite()]);
    h.dispatch.mockRejectedValueOnce(new Error('resend down'));
    h.invites.releaseClaim.mockRejectedValueOnce(new Error('db down'));
    const report = (await runRosterCli(h.deps, ['--send'])) as DeliveryReport;
    expect(report.failed).toHaveLength(1);
    expect(report.needsReview).toEqual(['inv-1']);
    expect(h.logs).toContain(
      '  could not release the claim on invite inv-1: db down',
    );
  });

  it('refuses an in-repo report path', async () => {
    const h = harness();
    await expect(
      runRosterCli(h.deps, ['--send', '--report', 'x.json']),
    ).rejects.toThrow(RosterCommandError);
    expect(h.invites.listUnsent).not.toHaveBeenCalled();
  });
});

describe('runRosterCli --remind', () => {
  it('sends invite.reminder to due invites and marks them reminded', async () => {
    const h = harness();
    const due = invite({ sent_at: '2026-10-01T00:00:00Z' });
    h.invites.listDueForReminder.mockResolvedValue([due]);
    const report = (await runRosterCli(h.deps, ['--remind'])) as DeliveryReport;
    expect(h.invites.listDueForReminder).toHaveBeenCalledWith(SEASON, NOW);
    expect(h.invites.claim).toHaveBeenCalledWith('inv-1', 'remind', NOW);
    expect(h.invites.listUnfinishedClaims).toHaveBeenCalledWith(
      SEASON,
      'remind',
    );
    expect(h.dispatch).toHaveBeenCalledWith(
      due,
      'invite.reminder',
      'sync',
      NOW,
      'invite-inv-1-remind-2026-10-11T04:00:00.000Z',
    );
    expect(h.invites.markReminded).toHaveBeenCalledWith('inv-1', NOW);
    expect(h.invites.markSent).not.toHaveBeenCalled();
    expect(report).toMatchObject({
      mode: 'remind',
      counts: { candidates: 1, sent: 1, failed: 0 },
    });
  });

  it('releases a failed reminder claim and reports stale reminder claims', async () => {
    const h = harness();
    h.invites.listUnfinishedClaims.mockResolvedValue(['inv-9']);
    h.invites.listDueForReminder.mockResolvedValue([invite()]);
    h.dispatch.mockRejectedValueOnce(new Error('resend down'));
    const report = (await runRosterCli(h.deps, ['--remind'])) as DeliveryReport;
    expect(h.invites.releaseClaim).toHaveBeenCalledWith('inv-1', 'remind', NOW);
    expect(h.invites.markReminded).not.toHaveBeenCalled();
    expect(report.needsReview).toEqual(['inv-9']);
    expect(h.logs).toContain(
      'Needs review: claimed but never marked reminded, so not sent again: inv-9',
    );
  });

  it('refuses an in-repo report path', async () => {
    const h = harness();
    await expect(
      runRosterCli(h.deps, ['--remind', '--report', 'x.json']),
    ).rejects.toThrow(RosterCommandError);
  });

  it('labels an unknown env', async () => {
    const h = harness(new Map(), {});
    const report = (await runRosterCli(h.deps, ['--remind'])) as DeliveryReport;
    expect(report.env).toBe('unknown');
  });
});

describe('runRosterCli --release-stale-claims', () => {
  it('releases send and reminder claims older than N minutes', async () => {
    const h = harness();
    h.invites.releaseStaleClaims.mockImplementation((_s, kind) =>
      Promise.resolve(kind === 'send' ? ['inv-1', 'inv-2'] : []),
    );
    const report = (await runRosterCli(h.deps, [
      '--release-stale-claims',
      '30',
      '--report',
      OUTSIDE,
    ])) as ReleaseReport;
    const cutoff = new Date('2026-10-11T03:30:00Z');
    expect(h.invites.releaseStaleClaims.mock.calls).toEqual([
      [SEASON, 'send', cutoff],
      [SEASON, 'remind', cutoff],
    ]);
    expect(report).toMatchObject({
      mode: 'release-stale-claims',
      claimedBefore: '2026-10-11T03:30:00.000Z',
      released: { send: ['inv-1', 'inv-2'], remind: [] },
    });
    expect(h.logs).toContain(
      'Released 2 send claim(s) taken before 2026-10-11T03:30:00.000Z: inv-1, inv-2',
    );
    expect(h.logs).toContain(
      'Released 0 remind claim(s) taken before 2026-10-11T03:30:00.000Z',
    );
    expect(h.written.has(OUTSIDE_RESOLVED)).toBe(true);
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('refuses an in-repo report path and unconfirmed prod', async () => {
    const h = harness();
    await expect(
      runRosterCli(h.deps, [
        '--release-stale-claims',
        '5',
        '--report',
        'x.json',
      ]),
    ).rejects.toThrow(RosterCommandError);
    const prod = harness(new Map(), { SSMS_ENV: 'prod' });
    await expect(
      runRosterCli(prod.deps, ['--release-stale-claims', '5']),
    ).rejects.toThrow(/SSMS_CONFIRM_PROD/);
    expect(h.invites.releaseStaleClaims).not.toHaveBeenCalled();
    expect(prod.invites.releaseStaleClaims).not.toHaveBeenCalled();
  });
});

const PARTIAL_CASI = 'CASI L3 Partial (Please specify in "Other")';
const PARTIAL_CSIA = 'CSIA L3 Partial (Please specify in "Other")';

const NORMALIZE_CSV = rosterCsv([
  {
    preferred: 'Robin',
    legal: 'Robin Privatename',
    email: 'robin@example.test',
    dob: '6/7/1992',
    certs: `CSIA L3, ${PARTIAL_CASI}, Ped&Teaching`,
    locations: 'BM, Shanghai',
  },
  {
    preferred: 'Sky',
    email: 'sky@example.test',
    certs: `${PARTIAL_CSIA}, Trainer course`,
    details: 'CSIA L3 hill 2026',
    locations: 'MSL, Ottawa Region',
  },
  {
    preferred: 'Tam',
    email: 'tam@example.test',
    certs: 'CSIA L2',
    locations: 'Blue Mountain',
  },
]);

function normalizeHarness(llmAnswers?: (request: RosterLlmRequest) => unknown) {
  const h = harness();
  (h.deps.readFile as jest.Mock).mockResolvedValue(NORMALIZE_CSV);
  const normalize = jest.fn((request: RosterLlmRequest) =>
    Promise.resolve(llmAnswers?.(request) ?? {}),
  );
  const llmFactory = jest.fn(
    (): RosterLlmNormalizer => ({ modelId: 'fake-model', normalize }),
  );
  h.deps.llm = llmFactory;
  return { ...h, normalize, llmFactory };
}

const SKY_ANSWERS = (request: RosterLlmRequest) =>
  request.unresolvedCertifications.includes(PARTIAL_CSIA)
    ? {
        certifications: [
          {
            value: PARTIAL_CSIA,
            certification: {
              org: 'csia',
              track: 'regular',
              level: 3,
              isPartial: true,
              partialComponents: ['ski'],
            },
            confidence: 0.9,
            reason: 'details mention ski',
          },
          {
            value: 'Trainer course',
            certification: {
              org: 'csia',
              track: 'park',
              level: 1,
              isPartial: true,
              partialComponents: ['ski'],
            },
            confidence: 0.99,
            reason: 'guess',
          },
        ],
        locations: [
          {
            value: 'Ottawa Region',
            key: 'teaching_location.moonstone',
            confidence: 0.5,
            reason: 'unsure',
          },
        ],
      }
    : {
        certifications: [],
        locations: [
          {
            value: 'Shanghai',
            key: 'teaching_location.blue_mountain',
            confidence: 0.95,
            reason: 'wrong but confident',
          },
        ],
      };

describe('runRosterCli normalisation review', () => {
  it('parses --normalize-with-llm for dry-run and apply only', () => {
    expect(
      parseRosterArgs(['--csv', 'a.csv', '--normalize-with-llm'])
        .normalizeWithLlm,
    ).toBe(true);
    expect(
      parseRosterArgs(['--normalize-with-llm', '--apply', '--csv', 'a.csv']),
    ).toMatchObject({ mode: 'apply', normalizeWithLlm: true });
    expect(() => parseRosterArgs(['--send', '--normalize-with-llm'])).toThrow(
      /--normalize-with-llm works with --dry-run and --apply only/,
    );
  });

  it('without the flag is deterministic only and never builds the LLM', async () => {
    const h = normalizeHarness(SKY_ANSWERS);
    const report = (await runRosterCli(h.deps, [
      '--csv',
      'roster.csv',
    ])) as ImportReport;
    expect(h.llmFactory).not.toHaveBeenCalled();
    expect(h.normalize).not.toHaveBeenCalled();
    expect(report.rows[0].review).toEqual({
      raw: {
        certifications: `CSIA L3, ${PARTIAL_CASI}, Ped&Teaching`,
        certificationDetails: '',
        locations: 'BM, Shanghai',
      },
      certifications: [
        { certification: 'CSIA Level 3', source: 'rule' },
        { certification: 'CASI Level 3 Partial [teaching]', source: 'rule' },
      ],
      trainerStatus: [],
      locations: [{ key: 'teaching_location.blue_mountain', source: 'rule' }],
      llmProposals: [],
      unresolved: [
        { kind: 'location', value: 'Shanghai', note: NO_REFERENCE_ROW },
      ],
    });
    expect(report.rows[1].unmappedCertifications).toEqual([
      PARTIAL_CSIA,
      'Trainer course',
    ]);
    expect(report.rows[2].review).toBeUndefined();
    expect(report.counts).toMatchObject({
      rowsNeedingReview: 2,
      llmCertificationsToWrite: 0,
      llmLocationsToWrite: 0,
    });
    expect(h.logs).toContain('Normalisation review (by CSV line):');
    expect(h.logs).toContain('  line 2');
    expect(h.logs).toContain(
      '    certification CASI Level 3 Partial [teaching] (rule)',
    );
    expect(h.logs).toContain(
      `    location "Shanghai" (unresolved: ${NO_REFERENCE_ROW})`,
    );
    expect(h.logs).toContain('    certification "Trainer course" (unresolved)');
    expect(h.logs.some((l) => l.includes('robin@') && l.includes('line'))).toBe(
      false,
    );
  });

  it('with the flag sends only unresolved rows, keeps validated answers and reports their source', async () => {
    const h = normalizeHarness(SKY_ANSWERS);
    const report = (await runRosterCli(h.deps, [
      '--csv',
      'roster.csv',
      '--normalize-with-llm',
      '--report',
      OUTSIDE,
    ])) as ImportReport;
    expect(h.llmFactory).toHaveBeenCalledTimes(1);
    expect(h.normalize.mock.calls).toEqual([
      [
        {
          certifications: `CSIA L3, ${PARTIAL_CASI}, Ped&Teaching`,
          certificationDetails: '',
          locations: 'BM, Shanghai',
          unresolvedCertifications: [],
          unresolvedLocations: ['Shanghai'],
        },
      ],
      [
        {
          certifications: `${PARTIAL_CSIA}, Trainer course`,
          certificationDetails: 'CSIA L3 hill 2026',
          locations: 'MSL, Ottawa Region',
          unresolvedCertifications: [PARTIAL_CSIA, 'Trainer course'],
          unresolvedLocations: ['Ottawa Region'],
        },
      ],
    ]);
    const sent = JSON.stringify(h.normalize.mock.calls);
    for (const secret of [
      'Robin',
      'Privatename',
      'robin@',
      'sky@',
      '1992',
      '555-0100',
      'Fake Street',
      '000000000',
    ]) {
      expect(sent).not.toContain(secret);
    }
    expect(h.factories.writer).not.toHaveBeenCalled();

    expect(report.rows[0].unmappedLocations).toEqual([]);
    expect(report.rows[0].review?.locations).toEqual([
      { key: 'teaching_location.blue_mountain', source: 'rule' },
    ]);
    expect(report.rows[0].review?.llmProposals).toEqual([
      { value: 'Shanghai', proposal: 'teaching_location.blue_mountain' },
    ]);
    expect(h.logs).toContain(
      '    llm read "Shanghai" as teaching_location.blue_mountain',
    );
    expect(report.rows[1].review).toMatchObject({
      certifications: [
        { certification: 'CSIA Level 3 Partial [ski]', source: 'llm' },
      ],
      locations: [{ key: 'teaching_location.moonstone', source: 'rule' }],
      unresolved: [
        {
          kind: 'certification',
          value: 'Trainer course',
          note: 'LLM: violates certification rules',
        },
        {
          kind: 'location',
          value: 'Ottawa Region',
          note: `${NO_REFERENCE_ROW}; LLM: low confidence 0.5`,
        },
      ],
    });
    expect(report.counts).toMatchObject({
      llmCertificationsToWrite: 1,
      llmLocationsToWrite: 0,
    });
    expect(h.logs).toContain(
      'LLM normalisation (fake-model): 2 row(s) with unresolved values',
    );
    expect(h.logs).toContain(
      '    certification CSIA Level 3 Partial [ski] (llm)',
    );
    expect(
      h.logs.some((l) =>
        l.startsWith(
          'LLM-derived values --apply would write (only with --normalize-with-llm, re-derived and re-validated in that run): 1 certification(s), 0 trainer status(es), 0 location(s).',
        ),
      ),
    ).toBe(true);
    const json = JSON.parse(
      h.written.get(OUTSIDE_RESOLVED) as string,
    ) as ImportReport;
    expect(json.rows[1].review?.certifications[0].source).toBe('llm');
  });

  it('adds LLM location keys, and drops those missing from the database', async () => {
    const h = normalizeHarness((request) => ({
      certifications: [],
      locations: request.unresolvedLocations.map((value) => ({
        value,
        key:
          value === 'Shanghai'
            ? 'teaching_location.tremblant'
            : 'teaching_location.blue_mountain',
        confidence: 0.9,
        reason: 'r',
      })),
    }));
    const report = (await runRosterCli(h.deps, [
      '--csv',
      'roster.csv',
      '--normalize-with-llm',
    ])) as ImportReport;
    expect(report.rows[0]).toMatchObject({
      llmLocations: 0,
      unmappedLocations: ['teaching_location.tremblant (key not in database)'],
    });
    expect(report.rows[1].review?.locations).toEqual([
      { key: 'teaching_location.moonstone', source: 'rule' },
      { key: 'teaching_location.blue_mountain', source: 'llm' },
    ]);
    expect(report.counts.llmLocationsToWrite).toBe(1);
  });

  it('a failed LLM request leaves the row unresolved', async () => {
    const h = normalizeHarness();
    h.normalize.mockRejectedValue(new Error('Gemini HTTP 503'));
    const report = (await runRosterCli(h.deps, [
      '--csv',
      'roster.csv',
      '--normalize-with-llm',
    ])) as ImportReport;
    expect(report.rows[1].unmappedCertifications).toEqual([
      PARTIAL_CSIA,
      'Trainer course',
    ]);
    expect(report.rows[1].review?.unresolved[0]).toEqual({
      kind: 'certification',
      value: PARTIAL_CSIA,
      note: 'LLM: request failed',
    });
    expect(h.logs).toContain('  line 3: LLM request failed: Gemini HTTP 503');
  });

  it('needs a provider only when some value is unresolved', async () => {
    const missing = normalizeHarness();
    missing.deps.llm = undefined;
    await expect(
      runRosterCli(missing.deps, [
        '--csv',
        'roster.csv',
        '--normalize-with-llm',
      ]),
    ).rejects.toThrow(/needs an LLM provider \(set GEMINI_API_KEY\)/);
    expect(missing.readUsers).not.toHaveBeenCalled();

    const clean = normalizeHarness();
    (clean.deps.readFile as jest.Mock).mockResolvedValue(
      rosterCsv([
        { email: 'tam@example.test', certs: 'CSIA L2', locations: 'MSL' },
      ]),
    );
    await runRosterCli(clean.deps, [
      '--csv',
      'roster.csv',
      '--normalize-with-llm',
    ]);
    expect(clean.llmFactory).not.toHaveBeenCalled();
    expect(clean.logs).toContain('LLM normalisation: no unresolved values');
  });

  it('--apply writes rule results without the flag and never the unresolved values', async () => {
    const h = normalizeHarness(SKY_ANSWERS);
    await runRosterCli(h.deps, ['--apply', '--csv', 'roster.csv']);
    expect(h.llmFactory).not.toHaveBeenCalled();
    expect(h.writer.setProfileRelations.mock.calls).toEqual([
      [
        'ins-for-auth-new-1',
        [
          full('csia', 'regular', 3),
          {
            ...full('casi', 'regular', 3),
            isPartial: true,
            partialComponents: ['teaching'],
          },
        ],
        ['loc-bm'],
        [],
      ],
      ['ins-for-auth-new-2', [], ['loc-msl'], []],
      ['ins-for-auth-new-3', [full('csia', 'regular', 2)], ['loc-bm'], []],
    ]);
    expect(h.logs).toContain(
      'LLM-derived values written by this run: 0 certification(s), 0 trainer status(es), 0 location(s). Unresolved values were not written.',
    );
  });

  it('--apply with the flag writes the validated LLM results of the same run and counts them', async () => {
    const h = normalizeHarness(SKY_ANSWERS);
    h.writer.findInstructorId.mockImplementation((authUserId: string) =>
      Promise.resolve(authUserId === 'auth-new-3' ? 'ins-existing' : null),
    );
    await runRosterCli(h.deps, [
      '--apply',
      '--csv',
      'roster.csv',
      '--normalize-with-llm',
    ]);
    expect(h.normalize).toHaveBeenCalledTimes(2);
    expect(h.writer.setProfileRelations.mock.calls[1]).toEqual([
      'ins-for-auth-new-2',
      [
        {
          ...full('csia', 'regular', 3),
          isPartial: true,
          partialComponents: ['ski'],
          source: 'llm',
        },
      ],
      ['loc-msl'],
      [],
    ]);
    expect(h.logs).toContain(
      'LLM-derived values written by this run: 1 certification(s), 0 trainer status(es), 0 location(s). Unresolved values were not written.',
    );
  });
});

function trainer(discipline: string, source = 'rule') {
  return {
    discipline,
    rookieSessionCompleted: true,
    trainerExamPassed: true,
    trainerLevel: 1,
    source,
  };
}

const TRAINER_CSV = rosterCsv([
  { email: 'uma@example.test', certs: 'CSIA L3, Td' },
  { email: 'val@example.test', certs: 'CASI L2, TD' },
  { email: 'wren@example.test', certs: 'CSIA L2, CASI L1, TD' },
  { email: 'xia@example.test', certs: 'Td' },
  { email: 'yuri@example.test', certs: 'CASI TD, CSIA L2' },
  { email: 'zed@example.test', certs: 'CASI trainer development' },
]);

function trainerHarness(users: Map<string, ExistingAuthUser> = new Map()) {
  const h = harness(users);
  (h.deps.readFile as jest.Mock).mockResolvedValue(TRAINER_CSV);
  return h;
}

describe('runRosterCli trainer development', () => {
  it('shows resolved and unresolved TD values in the dry-run review', async () => {
    const h = trainerHarness();
    const report = (await runRosterCli(h.deps, [
      '--csv',
      'roster.csv',
    ])) as ImportReport;
    expect(
      report.rows.map((r) => [
        r.email,
        r.review?.trainerStatus,
        r.unmappedCertifications,
      ]),
    ).toEqual([
      [
        'uma@example.test',
        [
          {
            trainer: 'Ski Trainer Level 1 (trainer development)',
            source: 'rule',
          },
        ],
        [],
      ],
      [
        'val@example.test',
        [
          {
            trainer: 'Snowboard Trainer Level 1 (trainer development)',
            source: 'rule',
          },
        ],
        [],
      ],
      ['wren@example.test', [], ['TD']],
      ['xia@example.test', [], ['Td']],
      [
        'yuri@example.test',
        [
          {
            trainer: 'Snowboard Trainer Level 1 (trainer development)',
            source: 'rule',
          },
        ],
        [],
      ],
      [
        'zed@example.test',
        [
          {
            trainer: 'Snowboard Trainer Level 1 (trainer development)',
            source: 'rule',
          },
        ],
        [],
      ],
    ]);
    expect(report.rows.map((r) => r.trainerStatus)).toEqual([1, 1, 0, 0, 1, 1]);
    expect(h.logs).toContain(
      '    trainer Ski Trainer Level 1 (trainer development) (rule)',
    );
    expect(h.logs).toContain('    certification "TD" (unresolved)');
    expect(h.logs).toContain('    certification "Td" (unresolved)');
    expect(h.factories.writer).not.toHaveBeenCalled();
  });

  it('--apply passes trainer status only for rows with a resolved TD', async () => {
    const h = trainerHarness();
    await runRosterCli(h.deps, ['--apply', '--csv', 'roster.csv']);
    expect(h.writer.setProfileRelations.mock.calls).toEqual([
      [
        'ins-for-auth-new-1',
        [full('csia', 'regular', 3)],
        [],
        [trainer('ski')],
      ],
      [
        'ins-for-auth-new-2',
        [full('casi', 'regular', 2)],
        [],
        [trainer('snowboard')],
      ],
      [
        'ins-for-auth-new-3',
        [full('csia', 'regular', 2), full('casi', 'regular', 1)],
        [],
        [],
      ],
      [
        'ins-for-auth-new-5',
        [full('csia', 'regular', 2)],
        [],
        [trainer('snowboard')],
      ],
      ['ins-for-auth-new-6', [], [], [trainer('snowboard')]],
    ]);
  });

  describe('rerun for a user with only a trainer status to write', () => {
    const zed = new Map([
      ['zed@example.test', { id: 'auth-zed', importedSeason: SEASON }],
    ]);

    async function rerun(hasRelations: boolean) {
      const h = trainerHarness(zed);
      h.writer.findInstructorId.mockImplementation((id: string) =>
        Promise.resolve(id === 'auth-zed' ? 'ins-zed' : null),
      );
      h.writer.hasProfileRelations.mockResolvedValue(hasRelations);
      h.writer.insertInvite.mockImplementation((i) =>
        Promise.resolve(i.auth_user_id !== 'auth-zed'),
      );
      const report = (await runRosterCli(h.deps, [
        '--apply',
        '--csv',
        'roster.csv',
      ])) as ImportReport;
      const row = report.rows.find((r) => r.email === 'zed@example.test');
      return { h, row };
    }

    it('checks for existing relations and writes the trainer status the crashed run never wrote', async () => {
      const { h, row } = await rerun(false);
      expect(h.writer.hasProfileRelations.mock.calls).toContainEqual([
        'ins-zed',
      ]);
      expect(h.writer.setProfileRelations.mock.calls).toContainEqual([
        'ins-zed',
        [],
        [],
        [trainer('snowboard')],
      ]);
      expect(row).toMatchObject({ status: 'repaired', relationsWritten: true });
    });

    it('leaves existing relations untouched', async () => {
      const { h, row } = await rerun(true);
      expect(
        h.writer.setProfileRelations.mock.calls.map(([id]) => id),
      ).not.toContain('ins-zed');
      expect(row).toMatchObject({
        status: 'already_imported',
        relationsWritten: false,
      });
    });
  });

  it('accepts a validated LLM trainer status and writes it with --apply', async () => {
    const h = normalizeHarness((request) =>
      request.unresolvedCertifications.includes('Trainer course')
        ? {
            certifications: [
              {
                value: 'Trainer course',
                certification: null,
                trainer: {
                  discipline: 'ski',
                  rookieSessionCompleted: true,
                  trainerExamPassed: true,
                  trainerLevel: 1,
                },
                confidence: 0.9,
                reason: 'trainer development',
              },
            ],
            locations: [],
          }
        : { certifications: [], locations: [] },
    );
    const report = (await runRosterCli(h.deps, [
      '--apply',
      '--csv',
      'roster.csv',
      '--normalize-with-llm',
    ])) as ImportReport;
    expect(report.rows[1]).toMatchObject({
      trainerStatus: 1,
      llmTrainerStatus: 1,
      unmappedCertifications: [PARTIAL_CSIA],
    });
    expect(report.rows[1].review).toMatchObject({
      trainerStatus: [
        { trainer: 'Ski Trainer Level 1 (trainer development)', source: 'llm' },
      ],
      llmProposals: [
        {
          value: 'Trainer course',
          proposal: 'Ski Trainer Level 1 (trainer development)',
        },
      ],
    });
    expect(h.writer.setProfileRelations.mock.calls[1]).toEqual([
      'ins-for-auth-new-2',
      [],
      ['loc-msl'],
      [trainer('ski', 'llm')],
    ]);
    expect(h.logs).toContain(
      'LLM-derived values written by this run: 0 certification(s), 1 trainer status(es), 0 location(s). Unresolved values were not written.',
    );
  });
});
