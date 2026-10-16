import { Module } from '@nestjs/common';
import { SeasonsModule } from '../seasons/seasons.module';
import { AdminInsuranceController } from './admin-insurance.controller';
import { AdminInsuranceService } from './admin-insurance.service';
import {
  LessonInsuranceRepository,
  SupabaseLessonInsuranceRepository,
} from './lesson-insurance.repository';
import { MeInsuranceController } from './me-insurance.controller';
import { MeInsuranceService } from './me-insurance.service';

@Module({
  imports: [SeasonsModule],
  controllers: [MeInsuranceController, AdminInsuranceController],
  providers: [
    {
      provide: LessonInsuranceRepository,
      useClass: SupabaseLessonInsuranceRepository,
    },
    MeInsuranceService,
    AdminInsuranceService,
  ],
  exports: [AdminInsuranceService],
})
export class InsuranceModule {}
