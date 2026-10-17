import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module';
import { MeLessonsController } from './me-lessons.controller';
import { MeLessonsService } from './me-lessons.service';
import { PayrollController } from './payroll.controller';
import {
  PayrollRepository,
  SupabasePayrollRepository,
} from './payroll.repository';
import { PayrollService } from './payroll.service';

@Module({
  imports: [DocumentsModule],
  controllers: [PayrollController, MeLessonsController],
  providers: [
    { provide: PayrollRepository, useClass: SupabasePayrollRepository },
    PayrollService,
    MeLessonsService,
  ],
})
export class PayrollModule {}
