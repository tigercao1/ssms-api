import { readFileSync } from 'node:fs';
import { decide } from '../../src/documents/cert-verification/certification-decision';
const dir = process.env.REAL_SAMPLES ?? '';
const labels = JSON.parse(readFileSync(dir + '/labels.json', 'utf8'));
let bad = 0;
for (const l of labels) {
  const x = {
    documentType: 'membership_card',
    issuer: null,
    org: l.truth.org,
    holderName: l.truth.holderName,
    memberNumber: l.truth.memberNumber,
    membershipCategory: null,
    membershipSeason: null,
    certifications: l.truth.certifications.map((c: any) => ({
      text: '',
      ...c,
      isPartial: false,
      confidence: 1,
    })),
    validThrough: l.truth.validThrough,
    recallYear: l.truth.recallYear,
    legible: true,
    tamperSigns: [],
    confidence: { holderName: 1, org: 1, memberNumber: 1, validThrough: 1 },
    notes: '',
  } as any;
  for (const r of l.runs) {
    const got = decide(x, r.declared, r.today).verdict;
    if (got !== r.expect) bad++;
    console.log(
      l.file,
      r.why.padEnd(32),
      r.expect.padEnd(15),
      got === r.expect ? 'ok' : 'MISMATCH ' + got,
    );
  }
}
console.log('mismatches', bad);
