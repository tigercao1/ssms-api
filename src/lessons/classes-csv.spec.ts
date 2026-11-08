import { classRow } from '../../test/helpers/lessons-fakes';
import { CLASS_EXPORT_COLUMNS, CSV_BOM, classesCsv } from './classes-csv';
import { toAdminClass } from './classes.service';

const lines = (csv: string) => csv.slice(CSV_BOM.length).split('\r\n');

describe('classesCsv', () => {
  it('starts with a BOM and the header row', () => {
    const csv = classesCsv([]);
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    expect(lines(csv)).toEqual([CLASS_EXPORT_COLUMNS.join(','), '']);
  });

  it('writes one row per class in the school time zone', () => {
    const row = classRow({
      id: '3f1c2b7a-9d4e-4c1a-8b2f-6a7e5d4c3b2a',
      starts_at: '2026-12-12T15:00:00.000Z',
      ends_at: '2026-12-12T16:30:00.000Z',
      created_at: '2026-11-08T03:15:00.000Z',
      status: 'no_show',
      notes: 'Bring rental skis',
      lesson_type: {
        name_en: 'Private 1h',
        name_zh: '1对1滑雪课',
        duration_min: 60,
        group_size: 1,
        is_promo: false,
      },
      location: { name: 'Blue Mountain' },
      participants: [
        {
          customer_id: 'c1',
          attendance: 'expected',
          customer: {
            first_name: '小明',
            last_name: '王',
            email: 'ming@example.com',
            phone: '+1 416 555 0101',
          },
        },
        {
          customer_id: 'c2',
          attendance: 'expected',
          customer: {
            first_name: 'Lily',
            last_name: null,
            email: null,
            phone: '647-555-0199',
          },
        },
      ],
    });
    expect(lines(classesCsv([toAdminClass(row)]))[1]).toBe(
      [
        '3f1c2b7a-9d4e-4c1a-8b2f-6a7e5d4c3b2a',
        '2026-12-12',
        '10:00',
        '11:30',
        'Eddie',
        'Private 1h',
        'Blue Mountain',
        'no_show',
        '小明 王; ming@example.com; +1 416 555 0101 | Lily; 647-555-0199',
        'Bring rental skis',
        '2026-11-07 22:15',
      ].join(','),
    );
  });

  it('falls back to Chinese names and leaves missing values blank', () => {
    const row = classRow({
      instructor: { display_name_en: '', display_name_zh: '艾迪' },
      lesson_type: {
        name_en: ' ',
        name_zh: '团体课',
        duration_min: 60,
        group_size: 4,
        is_promo: false,
      },
      participants: [
        { customer_id: 'c1', attendance: 'expected', customer: null },
      ],
    });
    const cells = lines(classesCsv([toAdminClass(row)]))[1].split(',');
    expect(cells.slice(4, 10)).toEqual([
      '艾迪',
      '团体课',
      '',
      'scheduled',
      '',
      '',
    ]);
  });

  it('quotes commas, quotes and line breaks', () => {
    const row = classRow({ notes: 'Meet at "lodge", door 2\nthen lift' });
    expect(classesCsv([toAdminClass(row)])).toContain(
      ',"Meet at ""lodge"", door 2\nthen lift",',
    );
  });

  it.each(['=HYPERLINK("x")', '+1 416', '-2+3', '@SUM(A1)'])(
    'neutralises a cell starting with a formula character: %j',
    (value) => {
      const row = classRow({
        notes: value,
        participants: [
          {
            customer_id: 'c1',
            attendance: 'expected',
            customer: {
              first_name: null,
              last_name: null,
              email: null,
              phone: value,
            },
          },
        ],
      });
      const csv = classesCsv([toAdminClass(row)]);
      const neutral = `'${value}`;
      const cell = /[",\r\n]/.test(neutral)
        ? `"${neutral.replace(/"/g, '""')}"`
        : neutral;
      expect(csv).toContain(`,${cell},${cell},`);
    },
  );
});
