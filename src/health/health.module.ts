import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

/** Temporary connectivity smoke test — see health.controller.ts. */
@Module({
  controllers: [HealthController],
})
export class HealthModule {}
