import { certificationUploadRow } from '../../test/helpers/documents-fakes';
import {
  goLiveFor,
  InMemorySyncRepository,
  readySnapshotOf,
  verifiedUpload,
} from '../../test/helpers/shopify-sync-fakes';
import type { InstructorStage } from './instructor-stage';
import type { InstructorSnapshot } from './instructor-sync.types';

const TODAY = '2026-10-19';

const idOf = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function setup() {
  const repo = new InMemorySyncRepository();
  const goLive = goLiveFor(repo);
  let next = 0;
  const add = (
    overrides: Parameters<typeof readySnapshotOf>[0] = {},
  ): string => {
    const id = idOf(++next);
    const snapshot: InstructorSnapshot = readySnapshotOf({
      ...overrides,
      instructor: { ...overrides.instructor, id },
    });
    repo.snapshots.set(id, snapshot);
    return id;
  };
  const verified = (id: string) =>
    goLive.subjects.uploads.push(verifiedUpload('csia', 'regular', 3, id));
  const pendingUpload = (id: string) =>
    goLive.subjects.uploads.push(
      certificationUploadRow({
        instructor_id: id,
        review_status: 'pending',
        valid_until: '2099-12-31',
        verified_level: null,
      }),
    );
  const outstandingDocument = (id: string) => {
    const template = goLive.templates.seed({ status: 'live' });
    goLive.assignments.seed({ template_id: template.id, subject_id: id });
  };
  const publish = (id: string, status: 'active' | 'draft') =>
    repo.saveState(id, { shopify_handle: `h-${id}`, last_status: status });
  return {
    repo,
    goLive,
    add,
    verified,
    pendingUpload,
    outstandingDocument,
    publish,
  };
}

describe('instructor stage', () => {
  it('derives every stage the same way for one instructor and for a batch', async () => {
    const ctx = setup();
    const expected = new Map<string, InstructorStage>();

    expected.set(
      ctx.add({ instructor: { approval_status: 'pending' } }),
      'pending',
    );
    expected.set(
      ctx.add({ instructor: { approval_status: 'rejected' } }),
      'rejected',
    );
    const deactivated = ctx.add({ instructor: { is_active: false } });
    ctx.verified(deactivated);
    await ctx.publish(deactivated, 'active');
    expected.set(deactivated, 'deactivated');
    expected.set(
      ctx.add({ instructor: { approval_status: 'pending', is_active: false } }),
      'deactivated',
    );
    expected.set(
      ctx.add({
        instructor: { approval_status: 'rejected', is_active: false },
      }),
      'deactivated',
    );

    const missingCert = ctx.add();
    expected.set(missingCert, 'onboarding');

    const profileGap = ctx.add({ instructor: { profile_photo_url: null } });
    ctx.pendingUpload(profileGap);
    expected.set(profileGap, 'onboarding');

    const documentOpen = ctx.add();
    ctx.pendingUpload(documentOpen);
    ctx.outstandingDocument(documentOpen);
    expected.set(documentOpen, 'onboarding');

    const inReview = ctx.add();
    ctx.pendingUpload(inReview);
    expected.set(inReview, 'in_review');

    const ready = ctx.add();
    ctx.verified(ready);
    await ctx.publish(ready, 'draft');
    expected.set(ready, 'going_live');

    const readyNeverSynced = ctx.add();
    ctx.verified(readyNeverSynced);
    expected.set(readyNeverSynced, 'going_live');

    const live = ctx.add();
    ctx.verified(live);
    await ctx.publish(live, 'active');
    expected.set(live, 'live');

    const ids = [...expected.keys()];
    const batch = await ctx.goLive.service.stages(ids, TODAY);
    const single = new Map<string, InstructorStage>();
    for (const id of ids) {
      single.set(id, (await ctx.goLive.service.status(id, TODAY)).stage);
    }

    expect(batch).toEqual(expected);
    expect(single).toEqual(expected);
    expect(new Set(expected.values())).toEqual(
      new Set([
        'pending',
        'rejected',
        'deactivated',
        'onboarding',
        'in_review',
        'going_live',
        'live',
      ]),
    );
  });

  it('stays live while the storefront entry is active, as the instructor sees it', async () => {
    const ctx = setup();
    const id = ctx.add();
    ctx.verified(id);
    await ctx.publish(id, 'active');
    ctx.outstandingDocument(id);

    expect((await ctx.goLive.service.stages([id], TODAY)).get(id)).toBe('live');
    expect((await ctx.goLive.service.status(id, TODAY)).stage).toBe('live');
  });

  it('leaves out ids that are not instructors and answers an empty batch', async () => {
    const ctx = setup();
    const id = ctx.add({ instructor: { approval_status: 'pending' } });

    expect(await ctx.goLive.service.stages([id, idOf(999)], TODAY)).toEqual(
      new Map([[id, 'pending']]),
    );
    expect(await ctx.goLive.service.stages([], TODAY)).toEqual(new Map());
  });
});
