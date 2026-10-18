import {
  FakeShopify,
  INSTRUCTOR_ID,
  InMemorySyncRepository,
  instructorRow,
} from '../../test/helpers/shopify-sync-fakes';
import {
  LegacyRoster,
  LegacyRosterUnavailableError,
  strongLegacyMatches,
} from './legacy-roster';
import { ShopifyInstructorGateway } from './shopify-instructor.gateway';

function setup() {
  const shopify = new FakeShopify();
  const repo = new InMemorySyncRepository();
  const roster = new LegacyRoster(
    new ShopifyInstructorGateway(shopify.client),
    repo,
  );
  return { shopify, repo, roster };
}

describe('strongLegacyMatches', () => {
  const legacy = [
    { handle: 'vincent-li', name: 'Vincent Li' },
    { handle: 'vincant', name: 'Vincant Li' },
    { handle: 'xiao-li', name: '小李 Vincent' },
    { handle: 'li-wensen', name: '李文森' },
    { handle: 'blank', name: '' },
  ];

  it('matches only an exact normalised English or Chinese name', () => {
    expect(
      strongLegacyMatches(
        { display_name_en: 'vincent-LI', display_name_zh: '李 文森' },
        legacy,
      ).map((e) => e.handle),
    ).toEqual(['vincent-li', 'li-wensen']);
  });

  it('ignores typos, partial nicknames and blank names', () => {
    expect(
      strongLegacyMatches(
        { display_name_en: 'Vincent', display_name_zh: null },
        legacy,
      ),
    ).toEqual([]);
  });
});

describe('LegacyRoster', () => {
  it('shares one in-flight fetch between concurrent callers', async () => {
    const { shopify, roster } = setup();
    shopify.addLegacyEntry('aaron', 'Aaron');

    const [a, b] = await Promise.all([roster.handles(), roster.handles()]);

    expect([...a]).toEqual(['aaron']);
    expect([...b]).toEqual(['aaron']);
    expect(shopify.operations()).toEqual(['SsmsLegacyRoster']);
  });

  it('does not fall back to a stale list once the cache window has passed', async () => {
    const { shopify, roster } = setup();
    const now = jest.spyOn(Date, 'now').mockReturnValue(0);
    try {
      await roster.handles();
      shopify.legacyRosterError = new Error('Throttled');
      now.mockReturnValue(5 * 60_000);
      await expect(roster.handles()).rejects.toThrow(
        LegacyRosterUnavailableError,
      );
      await expect(roster.handles()).rejects.toThrow('Throttled');
    } finally {
      now.mockRestore();
    }
  });

  it('holds on the first undismissed match nobody else is paired with', async () => {
    const { shopify, repo, roster } = setup();
    shopify.addLegacyEntry('eddie', 'Eddie Chen');
    shopify.addLegacyEntry('ai-di', '陈艾迪');
    shopify.addLegacyEntry('eddie-c', 'Eddie Chen');
    await repo.saveState('9b8a7c6d-0000-4000-8000-000000000001', {
      shopify_handle: 'ai-di',
    });
    await repo.saveState(INSTRUCTOR_ID, {
      shopify_handle: 'eddie-chen',
      dismissed_legacy_handles: ['eddie'],
    });

    await expect(
      roster.holdFor(
        instructorRow(),
        (await repo.getState(INSTRUCTOR_ID)) ?? null,
      ),
    ).resolves.toEqual({
      reason: 'legacy_pairing_decision',
      legacyHandle: 'eddie-c',
      legacyName: 'Eddie Chen',
      message: 'needs legacy pairing decision: eddie-c',
    });
  });

  it('treats a state row without the dismissal column as nothing dismissed', async () => {
    const { shopify, roster } = setup();
    shopify.addLegacyEntry('eddie', 'Eddie Chen');

    await expect(
      roster.holdFor(instructorRow(), {
        instructor_id: INSTRUCTOR_ID,
        shopify_metaobject_id: null,
        shopify_handle: null,
        shopify_photo_file_id: null,
        synced_photo_version: null,
        shopify_photo_2_file_id: null,
        synced_photo_2_version: null,
        shopify_photo_3_file_id: null,
        synced_photo_3_version: null,
        last_synced_at: null,
        last_status: null,
      }),
    ).resolves.toMatchObject({ legacyHandle: 'eddie' });
  });
});
