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
  RosterCommandError,
  SEND_INTERVAL_MS,
  assertOutsideRepo,
  assertProdConfirmed,
  parseRosterArgs,
  runRosterCli,
  type DeliveryReport,
  type ImportReport,
  type RosterDeps,
} from './roster-import';
import type {
  ExistingAuthUser,
  RosterReader,
  RosterWriter,
} from './roster-ports';

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
    sent_at: null,
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
      'listUnsent' | 'listDueForReminder' | 'markSent' | 'markReminded'
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
    setProfileRelations: jest.fn().mockResolvedValue(undefined),
    insertInvite: jest.fn().mockResolvedValue(undefined),
  };
  const invites = {
    listUnsent: jest.fn().mockResolvedValue([]),
    listDueForReminder: jest.fn().mockResolvedValue([]),
    markSent: jest.fn().mockResolvedValue(undefined),
    markReminded: jest.fn().mockResolvedValue(undefined),
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

describe('parseRosterArgs', () => {
  it('defaults to dry-run and season 2026/27', () => {
    expect(parseRosterArgs(['--csv', 'a.csv'])).toEqual({
      mode: 'dry-run',
      csv: 'a.csv',
      season: '2026/27',
      only: undefined,
      report: undefined,
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
    });
    expect(parseRosterArgs(['--remind']).mode).toBe('remind');
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

    const file = path.join(fs.realpathSync(os.tmpdir()), 'roster-report.json');
    const json = h.written.get(file) as string;
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
      [
        'ins-for-auth-new-1',
        [{ org: 'csia', track: 'regular', level: 3 }],
        ['loc-msl'],
      ],
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
      [{ org: 'casi', track: 'park', level: 1 }],
      [],
    ]);
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
  it('sends invite.season to each unsent invite, spaced ≥ 500 ms, and marks it sent', async () => {
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
    expect(h.dispatch.mock.calls).toEqual([
      [a, 'invite.season', 'sync', NOW],
      [b, 'invite.season', 'sync', NOW],
    ]);
    expect(h.sleep.mock.calls).toEqual([[SEND_INTERVAL_MS]]);
    expect(SEND_INTERVAL_MS).toBeGreaterThanOrEqual(500);
    expect(h.invites.markSent.mock.calls).toEqual([
      ['inv-1', NOW],
      ['inv-2', NOW],
    ]);
    expect(report.counts).toEqual({ candidates: 2, sent: 2, failed: 0 });
    expect(h.factories.writer).not.toHaveBeenCalled();
  });

  it('restricts to --only and leaves failed sends unmarked', async () => {
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
    expect(report.failed).toEqual([
      { email: 'avery@example.test', error: 'failed: resend down' },
    ]);
  });

  it('reports non-delivery errors too', async () => {
    const h = harness();
    h.invites.listUnsent.mockResolvedValue([invite()]);
    h.dispatch.mockRejectedValueOnce(new Error('db down'));
    const report = (await runRosterCli(h.deps, ['--send'])) as DeliveryReport;
    expect(report.failed[0].error).toBe('db down');
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
    expect(h.dispatch).toHaveBeenCalledWith(
      due,
      'invite.reminder',
      'sync',
      NOW,
    );
    expect(h.invites.markReminded).toHaveBeenCalledWith('inv-1', NOW);
    expect(report).toMatchObject({
      mode: 'remind',
      counts: { candidates: 1, sent: 1, failed: 0 },
    });
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
