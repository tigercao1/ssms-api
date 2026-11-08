#!/usr/bin/env ts-node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { PluginMetadataGenerator } from '@nestjs/cli/lib/compiler/plugins/plugin-metadata-generator';
import { ReadonlyVisitor } from '@nestjs/swagger/plugin';
import { format, resolveConfig } from 'prettier';

const ROOT = resolve(__dirname, '..');
const FILENAME = 'openapi-metadata.ts';
const OPENAPI_METADATA_PATH = join(ROOT, 'src/admin', FILENAME);

async function renderOpenApiMetadata(): Promise<string> {
  const outputDir = mkdtempSync(join(tmpdir(), 'ssms-openapi-'));
  try {
    new PluginMetadataGenerator().generate({
      visitors: [
        new ReadonlyVisitor({
          pathToSource: join(ROOT, 'src/admin'),
          controllerFileNameSuffix: [],
          introspectComments: true,
        }),
      ],
      outputDir,
      filename: FILENAME,
      tsconfigPath: relative(process.cwd(), join(ROOT, 'tsconfig.build.json')),
      printDiagnostics: false,
      watch: false,
    });
    const source = readFileSync(join(outputDir, FILENAME), 'utf8')
      .replaceAll('await import(', 'require(')
      .replaceAll('import(', 'require(');
    const options = await resolveConfig(OPENAPI_METADATA_PATH);
    return format(source, { ...options, filepath: OPENAPI_METADATA_PATH });
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const source = await renderOpenApiMetadata();
  if (!process.argv.includes('--check')) {
    writeFileSync(OPENAPI_METADATA_PATH, source);
  } else if (readFileSync(OPENAPI_METADATA_PATH, 'utf8') !== source) {
    console.error(
      `${relative(ROOT, OPENAPI_METADATA_PATH)} is stale: run npm run openapi:metadata`,
    );
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error((err as Error).message);
  process.exit(1);
});
