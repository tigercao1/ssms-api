import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import {
  FLY_APP_NAME_KEY,
  PRODUCTION_FLY_APP,
  runsBackgroundWorkers,
  runsOnProductionApp,
} from './process-group';

function configWith(group: string | undefined): ConfigService {
  return {
    get: (key: string) => (key === 'FLY_PROCESS_GROUP' ? group : undefined),
  } as unknown as ConfigService;
}

describe('runsBackgroundWorkers', () => {
  it('is off on the web process group', () => {
    expect(runsBackgroundWorkers(configWith('app'))).toBe(false);
    expect(runsBackgroundWorkers(configWith(' app '))).toBe(false);
  });

  it('is on in the worker process group', () => {
    expect(runsBackgroundWorkers(configWith('worker'))).toBe(true);
  });

  it('is on outside Fly, where no process group is set', () => {
    expect(runsBackgroundWorkers(configWith(undefined))).toBe(true);
  });
});

describe('runsOnProductionApp', () => {
  const appNamed = (name: string | undefined) =>
    ({
      get: (key: string) => (key === FLY_APP_NAME_KEY ? name : undefined),
    }) as unknown as ConfigService;

  it('names the app fly.toml deploys', () => {
    const toml = readFileSync(join(__dirname, '../../fly.toml'), 'utf8');
    expect(toml).toMatch(new RegExp(`^app = '${PRODUCTION_FLY_APP}'$`, 'm'));
  });

  it('is on only on the production Fly app', () => {
    expect(runsOnProductionApp(appNamed(PRODUCTION_FLY_APP))).toBe(true);
    expect(runsOnProductionApp(appNamed(` ${PRODUCTION_FLY_APP} `))).toBe(true);
  });

  it.each([['ssms-api-dev'], ['ssms-sign-api'], [''], [undefined]])(
    'is off on %j',
    (name) => {
      expect(runsOnProductionApp(appNamed(name))).toBe(false);
    },
  );
});
