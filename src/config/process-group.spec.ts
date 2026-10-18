import type { ConfigService } from '@nestjs/config';
import { runsBackgroundWorkers } from './process-group';

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
