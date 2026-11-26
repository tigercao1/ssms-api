#!/usr/bin/env ts-node
//
// Imports signed Jotform waivers through POST /admin/signatures/jotform.
//
//   SSMS_API_URL=... SSMS_ADMIN_TOKEN=... npx ts-node scripts/import-jotform-waivers.ts \
//     --submissions <in_range.json> --pdfs <dir of <submission id>.pdf> \
//     --manifest <out.csv> --review <out.csv> [--only <submission id>] [--dry-run]
//
// Keep every input and output outside the repo: they hold personal data.
// Re-running is safe; an imported submission comes back as `existing`.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  type JotformSubmission,
  mapJotformSubmission,
  toCsv,
} from '../src/documents/jotform-submission';
import type { JotformImportResult } from '../src/documents/jotform-imports.types';

const MANIFEST_HEADER = [
  'submission_id',
  'form_id',
  'submitted_at',
  'customer_id',
  'assignment_id',
  'pdf_sha256',
  'status',
] as const;
const REVIEW_HEADER = [
  'submission_id',
  'form_id',
  'created_at',
  'reason',
] as const;
const PAUSE_MS = 600;
const RATE_LIMIT_PAUSE_MS = 65_000;

type Row = Record<string, string | null>;

function args(argv: string[]) {
  const value = (name: string) => {
    const at = argv.indexOf(name);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const required = (name: string) => {
    const v = value(name);
    if (!v) {
      throw new Error(`${name} is required`);
    }
    return path.resolve(v);
  };
  return {
    submissions: required('--submissions'),
    pdfs: required('--pdfs'),
    manifest: required('--manifest'),
    review: required('--review'),
    only: value('--only'),
    dryRun: argv.includes('--dry-run'),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post(
  url: string,
  token: string,
  fields: Record<string, string>,
  pdf: Buffer,
): Promise<JotformImportResult> {
  for (let attempt = 1; ; attempt++) {
    const form = new FormData();
    for (const [name, v] of Object.entries(fields)) {
      form.append(name, v);
    }
    form.append(
      'pdf',
      new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }),
      `${fields.submissionId}.pdf`,
    );
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      body: form,
    });
    const body = await res.text();
    if (res.ok) {
      return JSON.parse(body) as JotformImportResult;
    }
    if ((res.status === 429 || res.status === 503) && attempt < 4) {
      await sleep(RATE_LIMIT_PAUSE_MS);
      continue;
    }
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
}

async function main(): Promise<void> {
  const opts = args(process.argv.slice(2));
  const apiUrl = process.env.SSMS_API_URL?.replace(/\/$/, '');
  const token = process.env.SSMS_ADMIN_TOKEN;
  if (!opts.dryRun && (!apiUrl || !token)) {
    throw new Error('SSMS_API_URL and SSMS_ADMIN_TOKEN must be set');
  }
  const submissions = (
    JSON.parse(
      await fs.readFile(opts.submissions, 'utf8'),
    ) as JotformSubmission[]
  ).filter((s) => !opts.only || s.id === opts.only);
  const manifest: Row[] = [];
  const review: Row[] = [];
  let failed = 0;
  for (const submission of submissions) {
    const mapped = mapJotformSubmission(submission);
    const pdf = await fs
      .readFile(path.join(opts.pdfs, `${submission.id}.pdf`))
      .catch(() => null);
    const reason = !mapped.ok ? mapped.reason : !pdf ? 'missing pdf' : null;
    if (reason || !mapped.ok || !pdf) {
      review.push({
        submission_id: submission.id,
        form_id: submission.form_id,
        created_at: submission.created_at,
        reason,
      });
      continue;
    }
    const sha256 = createHash('sha256').update(pdf).digest('hex');
    const row: Row = {
      submission_id: submission.id,
      form_id: submission.form_id,
      submitted_at: mapped.fields.submittedAt,
      customer_id: null,
      assignment_id: null,
      pdf_sha256: sha256,
      status: 'dry-run',
    };
    if (!opts.dryRun) {
      try {
        const result = await post(
          `${apiUrl}/admin/signatures/jotform`,
          token!,
          mapped.fields,
          pdf,
        );
        row.customer_id = result.customerId;
        row.assignment_id = result.assignmentId;
        row.status =
          result.status === 'imported' && result.signedSha256 !== sha256
            ? 'imported-sha-mismatch'
            : result.status;
        row.pdf_sha256 = result.signedSha256;
      } catch (err) {
        failed++;
        row.status = `error: ${(err as Error).message}`;
      }
      await sleep(PAUSE_MS);
    }
    manifest.push(row);
    console.log(`${submission.id} ${row.status}`);
  }
  await fs.writeFile(opts.manifest, toCsv(MANIFEST_HEADER, manifest), {
    mode: 0o600,
  });
  await fs.writeFile(opts.review, toCsv(REVIEW_HEADER, review), {
    mode: 0o600,
  });
  const counts = manifest.reduce<Record<string, number>>((acc, r) => {
    const key = r.status!.startsWith('error') ? 'error' : r.status!;
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  console.log(
    `submissions=${submissions.length} review=${review.length} ${Object.entries(
      counts,
    )
      .map(([k, n]) => `${k}=${n}`)
      .join(' ')}`,
  );
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(
    `import-jotform-waivers failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
