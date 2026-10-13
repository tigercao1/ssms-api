import {
  importCsv,
  IMPORT_HEADER,
} from '../../test/helpers/class-import-fakes';
import {
  ClassImportCsvError,
  parseImportCsv,
  rowFields,
} from './class-import-csv';

describe('parseImportCsv', () => {
  it('keys every cell by its header and numbers rows from 1', () => {
    const rows = parseImportCsv(
      `\uFEFF${importCsv([{ id: '9000001', notes: 'Bring "skis", poles' }, { id: '9000002' }])}`,
    );

    expect(rows.map((r) => [r.rowNo, r.externalId])).toEqual([
      [1, '9000001'],
      [2, '9000002'],
    ]);
    expect(rows[0].raw).toMatchObject({
      id: '9000001',
      'event.name': 'Private Lesson 2h',
      internalNotes: 'Bring "skis", poles',
      status: '',
    });
  });

  it('uses a placeholder id when the CSV id is blank or too long', () => {
    const rows = parseImportCsv(
      importCsv([{ id: ' ' }, { id: 'x'.repeat(201) }]),
    );
    expect(rows.map((r) => r.externalId)).toEqual(['row-1', 'row-2']);
  });

  it.each([
    ['', 'The CSV is empty'],
    [`${IMPORT_HEADER}\n`, 'The CSV has no rows'],
    ['id,availability\n1,x\n', /missing columns: event\.name, date\.startDate/],
    [
      `${IMPORT_HEADER}\n"unterminated`,
      'The CSV has an unterminated quoted field',
    ],
  ])('rejects %j', (text, message) => {
    expect(() => parseImportCsv(text)).toThrow(ClassImportCsvError);
    expect(() => parseImportCsv(text)).toThrow(message);
  });
});

describe('rowFields', () => {
  const raw = (overrides: Record<string, string> = {}) => ({
    ...parseImportCsv(importCsv([{}]))[0].raw,
    ...overrides,
  });

  it('reads times as UTC instants and joins the customer name', () => {
    expect(rowFields(raw())).toEqual({
      eventName: 'Private Lesson 2h',
      instructorName: 'Anna Example',
      customerName: 'Test Customer',
      email: 'test.customer@example.com',
      phone: null,
      startsAt: '2025-12-20T15:00:00.000Z',
      endsAt: '2025-12-20T17:00:00.000Z',
      deleted: false,
      valid: true,
    });
  });

  it('recognises deleted bookings in any case', () => {
    expect(rowFields(raw({ status: 'DELETED' })).deleted).toBe(true);
  });

  it.each([
    ['date.startDate', 'tomorrow'],
    ['date.startDate', '2025-13-45T10:00:00-05:00'],
    ['date.endDate', '2025-12-20T09:00:00-05:00'],
    ['id', ''],
  ])('marks the row invalid when %s is %j', (column, value) => {
    expect(rowFields(raw({ [column]: value })).valid).toBe(false);
  });

  it('treats non-string cells as blank', () => {
    expect(rowFields({ id: 5, 'event.name': null })).toMatchObject({
      eventName: null,
      valid: false,
    });
  });
});
