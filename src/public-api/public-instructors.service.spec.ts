import { NotFoundException } from '@nestjs/common';
import { ListInstructorsQueryDto } from './dto/list-instructors-query.dto';
import {
  ListPage,
  PublicInstructorsRepository,
} from './public-instructors.repository';
import {
  PAGE_SIZE,
  PublicInstructorsService,
} from './public-instructors.service';
import {
  ListInstructorsParams,
  PublicCertRow,
  PublicInstructorRow,
  PublicRefRow,
  PublicTrainerRow,
} from './public-api.types';

interface FakeData {
  instructors: PublicInstructorRow[];
  locations?: PublicRefRow[];
  languages?: PublicRefRow[];
  courseLevels?: PublicRefRow[];
  certs?: PublicCertRow[];
  trainers?: PublicTrainerRow[];
}

/** In-memory fake: listVisible returns a fixed page; reads filter by visibility. */
class FakeRepo extends PublicInstructorsRepository {
  lastParams?: ListInstructorsParams;

  constructor(
    private readonly data: FakeData,
    private readonly page: ListPage,
  ) {
    super();
  }

  listVisible(params: ListInstructorsParams): Promise<ListPage> {
    this.lastParams = params;
    return Promise.resolve(this.page);
  }

  findVisibleByIds(ids: string[]): Promise<PublicInstructorRow[]> {
    return Promise.resolve(
      this.data.instructors.filter((r) => ids.includes(r.id)),
    );
  }

  findVisibleById(id: string): Promise<PublicInstructorRow | null> {
    return Promise.resolve(
      this.data.instructors.find((r) => r.id === id) ?? null,
    );
  }

  getTeachingLocations(ids: string[]): Promise<PublicRefRow[]> {
    return Promise.resolve(
      (this.data.locations ?? []).filter((r) => ids.includes(r.instructor_id)),
    );
  }

  getLanguages(ids: string[]): Promise<PublicRefRow[]> {
    return Promise.resolve(
      (this.data.languages ?? []).filter((r) => ids.includes(r.instructor_id)),
    );
  }

  getCourseLevels(ids: string[]): Promise<PublicRefRow[]> {
    return Promise.resolve(
      (this.data.courseLevels ?? []).filter((r) =>
        ids.includes(r.instructor_id),
      ),
    );
  }

  getCertifications(ids: string[]): Promise<PublicCertRow[]> {
    return Promise.resolve(
      (this.data.certs ?? []).filter((r) => ids.includes(r.instructor_id)),
    );
  }

  getTrainerStatus(ids: string[]): Promise<PublicTrainerRow[]> {
    return Promise.resolve(
      (this.data.trainers ?? []).filter((r) => ids.includes(r.instructor_id)),
    );
  }
}

function row(
  over: Partial<PublicInstructorRow> & { id: string },
): PublicInstructorRow {
  return {
    display_name_en: 'Name',
    display_name_zh: null,
    bio_en: null,
    bio_zh: null,
    profile_photo_url: null,
    ...over,
  };
}

function makeQuery(
  over: Partial<ListInstructorsQueryDto> = {},
): ListInstructorsQueryDto {
  return Object.assign(new ListInstructorsQueryDto(), over);
}

describe('PublicInstructorsService', () => {
  describe('list', () => {
    it('returns the envelope with correct pagination metadata', async () => {
      const repo = new FakeRepo(
        { instructors: [row({ id: 'a' }), row({ id: 'b' })] },
        { ids: ['a', 'b'], totalCount: 137 },
      );
      const service = new PublicInstructorsService(repo);

      const result = await service.list(makeQuery({ page: 1 }));

      expect(result.page).toBe(1);
      expect(result.page_size).toBe(PAGE_SIZE);
      expect(result.total_count).toBe(137);
      expect(result.total_pages).toBe(3); // ceil(137 / 50)
      expect(result.data.map((d) => d.id)).toEqual(['a', 'b']);
    });

    it('preserves RPC ordering of ids', async () => {
      const repo = new FakeRepo(
        { instructors: [row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })] },
        { ids: ['c', 'a', 'b'], totalCount: 3 },
      );
      const service = new PublicInstructorsService(repo);
      const result = await service.list(makeQuery());
      expect(result.data.map((d) => d.id)).toEqual(['c', 'a', 'b']);
    });

    it('reports zero pages for an empty result', async () => {
      const repo = new FakeRepo(
        { instructors: [] },
        { ids: [], totalCount: 0 },
      );
      const service = new PublicInstructorsService(repo);
      const result = await service.list(makeQuery());
      expect(result.total_count).toBe(0);
      expect(result.total_pages).toBe(0);
      expect(result.data).toEqual([]);
    });

    it('forwards normalized filter params to the repo', async () => {
      const repo = new FakeRepo(
        { instructors: [] },
        { ids: [], totalCount: 0 },
      );
      const service = new PublicInstructorsService(repo);
      await service.list(
        makeQuery({
          locale: 'zh-CN',
          location: ['blue-mountain'],
          discipline: ['snowboard'],
          min_csia_level: 3,
          trainers_only: true,
          sort: 'seniority',
          order: 'asc',
        }),
      );
      expect(repo.lastParams).toMatchObject({
        locale: 'zh-CN',
        locations: ['blue-mountain'],
        disciplines: ['snowboard'],
        minCsiaLevel: 3,
        trainersOnly: true,
        sort: 'seniority',
        order: 'asc',
      });
    });

    it('localizes display_name/bio and hides internal columns', async () => {
      const repo = new FakeRepo(
        {
          instructors: [
            row({
              id: 'a',
              display_name_en: 'Jane',
              display_name_zh: '简',
              bio_en: 'Hello',
              bio_zh: '你好',
              profile_photo_url: 'https://img/a.png',
            }),
          ],
        },
        { ids: ['a'], totalCount: 1 },
      );
      const service = new PublicInstructorsService(repo);
      const result = await service.list(makeQuery({ locale: 'zh-CN' }));
      const dto = result.data[0];
      expect(dto.display_name).toBe('简');
      expect(dto.bio).toBe('你好');
      expect(dto.profile_photo_url).toBe('https://img/a.png');
      // No internal fields leak through.
      expect(dto).not.toHaveProperty('email');
      expect(dto).not.toHaveProperty('approval_status');
      expect(dto).not.toHaveProperty('display_name_en');
    });

    it('falls back to English display_name when zh missing', async () => {
      const repo = new FakeRepo(
        {
          instructors: [
            row({ id: 'a', display_name_en: 'Jane', display_name_zh: null }),
          ],
        },
        { ids: ['a'], totalCount: 1 },
      );
      const service = new PublicInstructorsService(repo);
      const result = await service.list(makeQuery({ locale: 'zh-CN' }));
      expect(result.data[0].display_name).toBe('Jane');
    });

    it('builds sorted {key,label} relations', async () => {
      const repo = new FakeRepo(
        {
          instructors: [row({ id: 'a' })],
          locations: [
            {
              instructor_id: 'a',
              key: 'glen-eden',
              name: 'Glen Eden',
              sort_order: 2,
            },
            {
              instructor_id: 'a',
              key: 'blue-mountain',
              name: 'Blue Mountain',
              sort_order: 1,
            },
          ],
          languages: [
            {
              instructor_id: 'a',
              key: 'english',
              name: 'English',
              sort_order: 1,
            },
          ],
        },
        { ids: ['a'], totalCount: 1 },
      );
      const service = new PublicInstructorsService(repo);
      const dto = (await service.list(makeQuery())).data[0];
      expect(dto.teaching_locations).toEqual([
        { key: 'blue-mountain', label: 'Blue Mountain' },
        { key: 'glen-eden', label: 'Glen Eden' },
      ]);
      expect(dto.languages).toEqual([{ key: 'english', label: 'English' }]);
    });

    it('nests certifications by discipline with formatted display strings', async () => {
      const repo = new FakeRepo(
        {
          instructors: [row({ id: 'a' })],
          certs: [
            {
              instructor_id: 'a',
              org: 'csia',
              track: 'regular',
              level: 3,
              is_partial: true,
            },
            {
              instructor_id: 'a',
              org: 'casi',
              track: 'carving',
              level: 1,
              is_partial: false,
            },
          ],
          trainers: [
            { instructor_id: 'a', discipline: 'snowboard', trainer_level: 2 },
          ],
        },
        { ids: ['a'], totalCount: 1 },
      );
      const service = new PublicInstructorsService(repo);
      const dto = (await service.list(makeQuery())).data[0];
      expect(dto.certifications.ski).toEqual({
        regular: 'CSIA Level 3 Partial',
        park: null,
        trainer: null,
      });
      expect(dto.certifications.snowboard).toEqual({
        regular: null,
        park: null,
        carving: 'CASI Carving Level 1',
        trainer: 'CASI Level 2 Trainer',
      });
    });

    it('omits a discipline block when no cert and not a trainer', async () => {
      const repo = new FakeRepo(
        {
          instructors: [row({ id: 'a' })],
          certs: [
            {
              instructor_id: 'a',
              org: 'csia',
              track: 'regular',
              level: 2,
              is_partial: false,
            },
          ],
        },
        { ids: ['a'], totalCount: 1 },
      );
      const service = new PublicInstructorsService(repo);
      const dto = (await service.list(makeQuery())).data[0];
      expect(dto.certifications.ski).toBeDefined();
      expect(dto.certifications.snowboard).toBeUndefined();
    });
  });

  describe('getById', () => {
    it('returns the DTO for a visible instructor', async () => {
      const repo = new FakeRepo(
        { instructors: [row({ id: 'a', display_name_en: 'Jane' })] },
        { ids: [], totalCount: 0 },
      );
      const service = new PublicInstructorsService(repo);
      const dto = await service.getById('a', 'en');
      expect(dto.id).toBe('a');
      expect(dto.display_name).toBe('Jane');
    });

    it('throws 404 for a non-visible / unknown id', async () => {
      const repo = new FakeRepo(
        { instructors: [] },
        { ids: [], totalCount: 0 },
      );
      const service = new PublicInstructorsService(repo);
      await expect(service.getById('missing', 'en')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
