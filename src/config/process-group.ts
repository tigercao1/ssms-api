import type { ConfigService } from '@nestjs/config';

export const PROCESS_GROUP_KEY = 'FLY_PROCESS_GROUP';
export const WEB_PROCESS_GROUP = 'app';

export function runsBackgroundWorkers(config: ConfigService): boolean {
  return config.get<string>(PROCESS_GROUP_KEY)?.trim() !== WEB_PROCESS_GROUP;
}
