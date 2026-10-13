import { Module } from '@nestjs/common';
import { PayrollController } from './payroll.controller';
import {
  PayrollRepository,
  SupabasePayrollRepository,
} from './payroll.repository';
import { PayrollService } from './payroll.service';

@Module({
  controllers: [PayrollController],
  providers: [
    { provide: PayrollRepository, useClass: SupabasePayrollRepository },
    PayrollService,
  ],
})
export class PayrollModule {}
