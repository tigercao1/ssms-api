import {
  BadRequestException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  classRow,
  InMemoryClassesRepository,
} from '../../test/helpers/lessons-fakes';
import { CSV_BOM } from './classes-csv';
import { MAX_CLASSES_PER_LIST } from './classes.repository';
import {
  CLASS_CREATED_RANGE_INVALID,
  CLASS_EXPORT_MAX_ROWS,
  CLASS_EXPORT_TOO_LARGE,
  CLASS_RANGE_INVALID,
  ClassesService,
} from './classes.service';

const startsAt = (n: number) =>
  new Date(Date.UTC(2026, 11, 1) + n * 60_000).toISOString();

function seeded(count: number) {
  const repo = new InMemoryClassesRepository();
  repo.rows.push(
    ...Array.from({ length: count }, (_, i) =>
      classRow({ starts_at: startsAt(i), ends_at: startsAt(i + 60) }),
    ),
  );
  return { repo, service: new ClassesService(repo) };
}

const dataLines = (body: string) =>
  body.slice(CSV_BOM.length).trimEnd().split('\r\n').slice(1);

describe('ClassesService', () => {
  it('passes the sort through to the repository', async () => {
    const { repo, service } = seeded(1);
    await service.list({}, 1, 10, 'createdAt');
    expect(repo.sorts).toEqual(['createdAt']);
  });

  it.each([
    [{ from: '2026-12-14', to: '2026-12-13' }, CLASS_RANGE_INVALID],
    [
      { createdFrom: '2026-11-08', createdTo: '2026-11-08' },
      CLASS_CREATED_RANGE_INVALID,
    ],
  ])('rejects an empty window %j', async (filter, message) => {
    const { repo, service } = seeded(1);
    await expect(service.list(filter)).rejects.toThrow(
      new BadRequestException(message),
    );
    await expect(service.export(filter)).rejects.toThrow(
      new BadRequestException(message),
    );
    expect(repo.filters).toEqual([]);
  });

  it('exports every match in chunks the database will return', async () => {
    const total = MAX_CLASSES_PER_LIST * 2 + 5;
    const { repo, service } = seeded(total);
    const file = await service.export(
      { statuses: ['scheduled'] },
      'startsAt',
      new Date('2026-11-09T03:00:00.000Z'),
    );
    expect(file.filename).toBe('classes-2026-11-08.csv');
    expect(dataLines(file.body)).toHaveLength(total);
    expect(repo.pages).toEqual([
      { limit: MAX_CLASSES_PER_LIST, offset: 0 },
      { limit: MAX_CLASSES_PER_LIST, offset: MAX_CLASSES_PER_LIST },
      { limit: MAX_CLASSES_PER_LIST, offset: MAX_CLASSES_PER_LIST * 2 },
    ]);
    expect(repo.filters).toEqual(Array(3).fill({ statuses: ['scheduled'] }));
    expect(repo.sorts).toEqual(['startsAt', 'startsAt', 'startsAt']);
  });

  it('stops when a later chunk comes back empty', async () => {
    const { repo, service } = seeded(3);
    const { rows } = await repo.list({});
    jest
      .spyOn(repo, 'list')
      .mockResolvedValueOnce({ rows, total: 10 })
      .mockResolvedValueOnce({ rows: [], total: 3 });
    const file = await service.export({});
    expect(dataLines(file.body)).toHaveLength(3);
  });

  it('exports exactly the cap', async () => {
    const { service } = seeded(CLASS_EXPORT_MAX_ROWS);
    const file = await service.export({});
    expect(dataLines(file.body)).toHaveLength(CLASS_EXPORT_MAX_ROWS);
  });

  it('refuses an export over the cap after one count', async () => {
    const { repo, service } = seeded(CLASS_EXPORT_MAX_ROWS + 1);
    await expect(service.export({})).rejects.toThrow(
      new UnprocessableEntityException(CLASS_EXPORT_TOO_LARGE),
    );
    expect(repo.pages).toHaveLength(1);
  });
});
