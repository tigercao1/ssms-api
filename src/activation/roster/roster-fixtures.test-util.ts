export const ROSTER_HEADER = [
  'Timestamp',
  'Preferred Name',
  'WeChat Name',
  'Highest instructor certification (Select all that apply if certified in both CSIA and CASI) ',
  'Preferred teaching locations ',
  'Legal Full Name (as shown on official ID) ',
  'Phone Number ',
  'Home Address ',
  'Date of Birth ',
  'Email Address ',
  'SIN Number if T4A Required',
];

export interface FixtureRow {
  preferred?: string;
  certs?: string;
  locations?: string;
  legal?: string;
  dob?: string;
  email?: string;
}

function cell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** A Google-Form-shaped CSV of invented people. */
export function rosterCsv(rows: FixtureRow[]): string {
  const lines = [ROSTER_HEADER.map(cell).join(',')];
  for (const r of rows) {
    lines.push(
      [
        '9/1/2026 10:00:00',
        r.preferred ?? '',
        'wx-fake',
        r.certs ?? '',
        r.locations ?? '',
        r.legal ?? '',
        '555-0100',
        '1 Fake Street',
        r.dob ?? '',
        r.email ?? '',
        '000000000',
      ]
        .map(cell)
        .join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}
