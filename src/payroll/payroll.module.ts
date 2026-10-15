import { Module } from '@nestjs/common';
import { MeLessonsController } from './me-lessons.controller';
import { MeLessonsService } from './me-lessons.service';
import { PayrollController } from './payroll.controller';
import {
  PayrollRepository,
  SupabasePayrollRepository,
} from './payroll.repository';
import { PayrollService } from './payroll.service';

@Module({
  controllers: [PayrollController, MeLessonsController],
  providers: [
    { provide: PayrollRepository, useClass: SupabasePayrollRepository },
    PayrollService,
    MeLessonsService,
  ],
})
export class PayrollModule {}
