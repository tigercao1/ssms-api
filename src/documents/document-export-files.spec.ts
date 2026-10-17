import {
  csvCell,
  exportDownloadName,
  exportFolderName,
  manifestLine,
  sanitizeSegment,
  signedCopyBaseName,
  UniqueNames,
} from './document-export-files';
import type { TemplateAssignmentDbRow } from './document-exports.types';

const row = (
  overrides: Partial<TemplateAssignmentDbRow> = {},
): TemplateAssignmentDbRow => ({
  id: 'a1',
  status: 'completed',
  season: '2026/27',
  instructor_id: 'i1',
  first_name: 'Ann',
  last_name: 'Wong',
  email: 'ann@example.com',
  signer_name: 'Ann Wong',
  signer_email: 'ann@example.com',
  assigned_at: '2026-10-01T00:00:00Z',
  viewed_at: null,
  completed_at: '2026-10-02T15:00:00Z',
  signed_sha256: null,
  signed_key: 'k',
  total_count: 1,
  ...overrides,
});

describe('export file names', () => {
  it('sanitises path segments and falls back when nothing is left', () => {
    expect(sanitizeSegment(' a/b\\c:d*e?f"g<h>i|j\u0007k ', 'x')).toBe(
      'a b c d e f g h i j k',
    );
    expect(sanitizeSegment('ends with dots...', 'x')).toBe('ends with dots');
    expect(sanitizeSegment('///', 'fallback')).toBe('fallback');
    expect(sanitizeSegment('y'.repeat(300), 'x')).toHaveLength(120);
  });

  it('names the folder by title and season', () => {
    expect(exportFolderName('Waiver', '2026/27')).toBe('Waiver (2026-27)');
    expect(exportFolderName('Waiver', null)).toBe('Waiver');
    expect(exportFolderName('/', null)).toBe('Signed documents');
  });

  it('names a copy by last, first and the Toronto signing date', () => {
    expect(signedCopyBaseName(row())).toBe('Wong, Ann - 2026-10-02');
    expect(
      signedCopyBaseName(row({ completed_at: '2026-10-03T02:00:00Z' })),
    ).toBe('Wong, Ann - 2026-10-02');
    expect(signedCopyBaseName(row({ first_name: null }))).toBe(
      'Wong - 2026-10-02',
    );
    expect(signedCopyBaseName(row({ first_name: null, last_name: '  ' }))).toBe(
      'Ann Wong - 2026-10-02',
    );
    expect(
      signedCopyBaseName(
        row({ first_name: null, last_name: null, signer_name: null }),
      ),
    ).toBe('ann@example.com - 2026-10-02');
    expect(
      signedCopyBaseName(
        row({
          first_name: null,
          last_name: null,
          signer_name: null,
          email: null,
          completed_at: null,
        }),
      ),
    ).toBe('a1');
  });

  it('suffixes case-insensitive collisions', () => {
    const names = new UniqueNames();
    expect(names.take('Wong, Ann', '.pdf')).toBe('Wong, Ann.pdf');
    expect(names.take('wong, ann', '.pdf')).toBe('wong, ann (2).pdf');
    expect(names.take('Wong, Ann', '.pdf')).toBe('Wong, Ann (3).pdf');
  });

  it('names the download <slug>-<season>-signed.zip', () => {
    expect(exportDownloadName('Instructor Agreement', '2026/27')).toBe(
      'instructor-agreement-2026-27-signed.zip',
    );
    expect(exportDownloadName('Café Waiver!', null)).toBe(
      'cafe-waiver-signed.zip',
    );
    expect(exportDownloadName('教练协议', '2026/27')).toBe(
      'documents-2026-27-signed.zip',
    );
    expect(exportDownloadName('a', '///')).toBe('a-signed.zip');
  });
});

describe('manifest CSV', () => {
  it.each([
    ['=SUM(A1)', "'=SUM(A1)"],
    ['+1', "'+1"],
    ['-1', "'-1"],
    ['@x', "'@x"],
    ['plain', 'plain'],
    ['a,b', '"a,b"'],
    ['say "hi"', '"say ""hi"""'],
    ['line\nbreak', '"line\nbreak"'],
    [null, ''],
  ])('csvCell(%j) → %j', (value, expected) => {
    expect(csvCell(value)).toBe(expected);
  });

  it('writes one line per copy with a skip note', () => {
    expect(manifestLine(row({ first_name: null }), null, 'too large')).toBe(
      'Wong,ann@example.com,Ann Wong,2026-10-02T15:00:00.000Z,2026/27,a1,,,skipped: too large\r\n',
    );
    expect(manifestLine(row({ completed_at: null }), 'f/Wong.pdf', null)).toBe(
      'Ann Wong,ann@example.com,Ann Wong,,2026/27,a1,,f/Wong.pdf,\r\n',
    );
  });
});
