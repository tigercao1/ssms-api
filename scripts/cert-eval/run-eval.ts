import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  OpenRouterClient,
  type Routing,
} from '../../src/llm/openrouter.client';
import { CertificationReader } from '../../src/documents/cert-verification/certification-reader';
import { decide } from '../../src/documents/cert-verification/certification-decision';

interface Case {
  id: string;
  pdf?: boolean;
  declared: {
    org: 'csia' | 'casi';
    track: 'regular' | 'park' | 'carving';
    level: number;
    validUntil: string;
  };
  expect: 'verified' | 'needs_review' | 'likely_invalid';
}

const TODAY = '2026-10-18';
const LEGAL_NAME = { firstName: 'Mei Lin', lastName: 'Chen' };

async function main() {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('Set OPENROUTER_API_KEY to run the live eval.');
  }
  const routes: Record<string, Routing> = {
    auto: { model: 'openrouter/auto' },
    'auto-vision-allowlist': {
      model: 'openrouter/auto',
      allowedModels: (
        process.env.CERT_ALLOWED_MODELS ??
        'google/gemini-2.5-flash,openai/gpt-4.1-mini,anthropic/claude-sonnet-4.5'
      ).split(','),
    },
    pinned: {
      model: process.env.CERT_MODEL ?? 'google/gemini-2.5-flash',
      fallbacks: (process.env.CERT_FALLBACKS ?? 'openai/gpt-4.1-mini')
        .split(',')
        .filter(Boolean),
    },
  };
  const only = process.env.ROUTES?.split(',');
  const cases = JSON.parse(
    readFileSync(join(__dirname, 'cases.json'), 'utf8'),
  ) as Case[];
  const client = new OpenRouterClient({ apiKey, appTitle: 'SSMS cert eval' });
  const report: Record<string, unknown> = { today: TODAY, runs: {} };
  for (const [name, routing] of Object.entries(routes)) {
    if (only && !only.includes(name)) continue;
    const reader = new CertificationReader(client, routing);
    const rows: Record<string, any>[] = [];
    for (const c of cases) {
      const file = join(
        __dirname,
        'fixtures',
        `${c.id}.${c.pdf ? 'pdf' : 'png'}`,
      );
      if (!existsSync(file))
        throw new Error(`Missing fixture ${file}; run make-fixtures.cjs`);
      const started = Date.now();
      try {
        const reading = await reader.read({
          bytes: readFileSync(file),
          contentType: c.pdf ? 'application/pdf' : 'image/png',
        });
        const decision = decide(
          reading.extraction,
          { legalName: LEGAL_NAME, isPartial: false, ...c.declared },
          TODAY,
        );
        rows.push({
          id: c.id,
          expect: c.expect,
          got: decision.verdict,
          model: reading.model,
          cost: reading.cost,
          ms: Date.now() - started,
          checks: decision.checks.filter((k) => k.status !== 'pass'),
          extraction: reading.extraction,
        });
      } catch (err) {
        rows.push({
          id: c.id,
          expect: c.expect,
          got: 'error',
          error: (err as Error).message,
          ms: Date.now() - started,
        });
      }
      const last = rows[rows.length - 1];
      console.log(
        `${name.padEnd(22)} ${c.id.padEnd(22)} expect=${c.expect.padEnd(15)} got=${String(last.got).padEnd(15)} ${'model' in last ? last.model : ''}`,
      );
    }
    const falseVerified = rows.filter(
      (r) => r.got === 'verified' && r.expect !== 'verified',
    ).length;
    const correct = rows.filter((r) => r.got === r.expect).length;
    const missedAuto = rows.filter(
      (r) => r.expect === 'verified' && r.got !== 'verified',
    ).length;
    (report.runs as Record<string, unknown>)[name] = {
      routing,
      correct,
      total: rows.length,
      falseVerified,
      missedAuto,
      rows,
    };
    console.log(
      `${name}: ${correct}/${rows.length} correct, falseVerified=${falseVerified}, verifiable-sent-to-review=${missedAuto}`,
    );
  }
  const outPath = process.env.EVAL_OUT ?? join(__dirname, 'eval-result.json');
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log('wrote', outPath);
}

void main();
