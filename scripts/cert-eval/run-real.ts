import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  OpenRouterClient,
  type Routing,
} from '../../src/llm/openrouter.client';
import { CertificationReader } from '../../src/documents/cert-verification/certification-reader';
import {
  type DeclaredCertification,
  decide,
} from '../../src/documents/cert-verification/certification-decision';

interface Label {
  file: string;
  truth: {
    org: string;
    holderName: string;
    memberNumber: string;
    validThrough: string;
    recallYear: number | null;
    certifications: { track: string; level: number }[];
  };
  runs: {
    today: string;
    declared: DeclaredCertification;
    expect: string;
    why: string;
  }[];
}

async function main() {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  const dir = process.env.REAL_SAMPLES;
  if (!apiKey || !dir)
    throw new Error(
      'Set OPENROUTER_API_KEY and REAL_SAMPLES (folder with labels.json).',
    );
  const routing: Routing =
    process.env.CERT_MODEL === 'openrouter/auto'
      ? { model: 'openrouter/auto' }
      : {
          model: process.env.CERT_MODEL ?? 'google/gemini-2.5-flash',
          fallbacks: (process.env.CERT_FALLBACKS ?? '')
            .split(',')
            .filter(Boolean),
        };
  const reader = new CertificationReader(
    new OpenRouterClient({ apiKey, appTitle: 'SSMS cert eval' }),
    routing,
  );
  const labels = JSON.parse(
    readFileSync(join(dir, 'labels.json'), 'utf8'),
  ) as Label[];
  const out: Record<string, unknown>[] = [];
  let fieldsRight = 0,
    fieldsTotal = 0,
    verdictsRight = 0,
    verdictsTotal = 0,
    falseVerified = 0;
  for (const label of labels) {
    const reading = await reader.read({
      bytes: readFileSync(join(dir, label.file)),
      contentType: 'image/png',
    });
    const x = reading.extraction;
    const lines = (l: { track: string | null; level: number | null }[]) =>
      l
        .map((c) => `${c.track}:${c.level}`)
        .sort()
        .join(',');
    const fields: Record<string, boolean> = {
      org: x.org === label.truth.org,
      holderName: x.holderName === label.truth.holderName,
      memberNumber: x.memberNumber === label.truth.memberNumber,
      validThrough: x.validThrough === label.truth.validThrough,
      recallYear: x.recallYear === label.truth.recallYear,
      certifications:
        lines(x.certifications) === lines(label.truth.certifications),
    };
    fieldsRight += Object.values(fields).filter(Boolean).length;
    fieldsTotal += Object.keys(fields).length;
    const runs = label.runs.map((run) => {
      const got = decide(x, run.declared, run.today).verdict;
      verdictsTotal++;
      if (got === run.expect) verdictsRight++;
      if (got === 'verified' && run.expect !== 'verified') falseVerified++;
      return { ...run, got };
    });
    console.log(
      label.file,
      reading.model,
      JSON.stringify(fields),
      runs.map((r) => `${r.why}: ${r.expect}→${r.got}`).join(' | '),
    );
    out.push({
      file: label.file,
      model: reading.model,
      cost: reading.cost,
      fields,
      extraction: x,
      runs,
    });
  }
  console.log(
    `fields ${fieldsRight}/${fieldsTotal}, verdicts ${verdictsRight}/${verdictsTotal}, falseVerified ${falseVerified}`,
  );
  writeFileSync(
    join(dir, `eval-${routing.model.replace(/\W+/g, '_')}.json`),
    JSON.stringify(out, null, 2),
  );
}

void main();
