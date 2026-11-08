import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

describe('openapi-metadata.ts', () => {
  it('matches the DTOs', () => {
    expect(() =>
      execFileSync(
        process.execPath,
        [
          require.resolve('ts-node/dist/bin'),
          '--transpile-only',
          join(__dirname, '../../scripts/generate-openapi-metadata.ts'),
          '--check',
        ],
        { stdio: 'pipe' },
      ),
    ).not.toThrow();
  }, 60_000);
});
