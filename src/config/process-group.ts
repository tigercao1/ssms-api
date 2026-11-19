import type { ConfigService } from '@nestjs/config';

export const PROCESS_GROUP_KEY = 'FLY_PROCESS_GROUP';
export const WEB_PROCESS_GROUP = 'app';

export function runsBackgroundWorkers(config: ConfigService): boolean {
  return config.get<string>(PROCESS_GROUP_KEY)?.trim() !== WEB_PROCESS_GROUP;
}

export const FLY_APP_NAME_KEY = 'FLY_APP_NAME';
export const PRODUCTION_FLY_APP = 'ssms-api-vivid-brook-6788';

export function runsOnProductionApp(config: ConfigService): boolean {
  return config.get<string>(FLY_APP_NAME_KEY)?.trim() === PRODUCTION_FLY_APP;
}
