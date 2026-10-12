import { recordingSupabase } from '../../test/helpers/lessons-fakes';
import { DatabaseError, PG_EXCLUSION_VIOLATION } from '../database/db-result';
import {
  PAY_RATE_COLUMNS,
  SupabasePayRatesRepository,
} from './pay-rates.repository';

const ID = '3f1c2b7a-9d4e-4c1a-8b2f-6a7e5d4c3b2a';
const TYPE = '4a5b6c7d-8e9f-4a0b-9c1d-2e3f4a5b6c7d';
const row = { id: ID };
const fail = { data: null, error: { message: 'boom' } };
const insert = {
  lesson_type_id: TYPE,
  instructor_id: null,
  hourly_rate: 40,
  effective_from: '2026-11-01',
  effective_to: null,
  created_by: null,
};

describe('SupabasePayRatesRepository', () => {
  it('lists with every filter', async () => {
    const { client, queries } = recordingSupabase({
      pay_rates: { data: [row], error: null },
    });
    const repo = new SupabasePayRatesRepository(client);
    await expect(repo.list({})).resolves.toEqual([row]);
    await repo.list({
      lessonTypeId: TYPE,
      instructorId: ID,
      scope: 'override',
    });
    await repo.list({ scope: 'default' });
    expect(queries[0].ops[0]).toEqual(['select', PAY_RATE_COLUMNS]);
    expect(queries[1].ops).toEqual(
      expect.arrayContaining([
        ['eq', 'lesson_type_id', TYPE],
        ['eq', 'instructor_id', ID],
        ['not', 'instructor_id', 'is', null],
      ]),
    );
    expect(queries[2].ops).toContainEqual(['is', 'instructor_id', null]);
  });

  it('loads the default and the instructor’s own rates for one lesson type', async () => {
    const { client, queries } = recordingSupabase({
      pay_rates: { data: [row], error: null },
    });
    await expect(
      new SupabasePayRatesRepository(client).ratesFor(TYPE, ID),
    ).resolves.toEqual([row]);
    expect(queries[0].ops).toEqual([
      ['select', PAY_RATE_COLUMNS],
      ['eq', 'lesson_type_id', TYPE],
      ['or', `instructor_id.is.null,instructor_id.eq.${ID}`],
    ]);
  });

  it('finds, inserts and updates', async () => {
    const { client, queries } = recordingSupabase({
      pay_rates: [
        { data: row, error: null },
        { data: row, error: null },
        { data: row, error: null },
        { data: null, error: null },
      ],
    });
    const repo = new SupabasePayRatesRepository(client);
    await expect(repo.findById(ID)).resolves.toEqual(row);
    await expect(repo.insert(insert)).resolves.toEqual(row);
    await expect(repo.update(ID, { hourly_rate: 41 })).resolves.toEqual(row);
    await expect(repo.update(ID, { hourly_rate: 41 })).resolves.toBeNull();
    expect(queries[1].ops[0]).toEqual(['insert', insert]);
  });

  it('fails when the insert returns no row and keeps Postgres error codes', async () => {
    await expect(
      new SupabasePayRatesRepository(recordingSupabase().client).insert(insert),
    ).rejects.toThrow('no row returned');
    const { client } = recordingSupabase({
      pay_rates: {
        data: null,
        error: { message: 'overlap', code: PG_EXCLUSION_VIOLATION },
      },
    });
    await expect(
      new SupabasePayRatesRepository(client).insert(insert),
    ).rejects.toMatchObject({ code: PG_EXCLUSION_VIOLATION });
  });

  it.each([
    ['list', (r: SupabasePayRatesRepository) => r.list({})],
    ['findById', (r: SupabasePayRatesRepository) => r.findById(ID)],
    ['ratesFor', (r: SupabasePayRatesRepository) => r.ratesFor(TYPE, ID)],
    ['update', (r: SupabasePayRatesRepository) => r.update(ID, {})],
  ])('%s surfaces database errors', async (_name, call) => {
    const { client } = recordingSupabase({ pay_rates: fail });
    await expect(call(new SupabasePayRatesRepository(client))).rejects.toThrow(
      DatabaseError,
    );
  });
});
