#!/usr/bin/env ts-node
import { promises as fs } from 'node:fs';
import { proposeLessonTypes } from '../src/lessons/lesson-type-proposals';

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) {
    console.error(
      'Usage: npx ts-node scripts/propose-lesson-types.ts <booking-export.csv>',
    );
    process.exit(2);
  }
  const proposals = proposeLessonTypes(await fs.readFile(file, 'utf8'));
  console.log(JSON.stringify(proposals, null, 2));
}

main().catch((err: unknown) => {
  console.error((err as Error).message);
  process.exit(1);
});
