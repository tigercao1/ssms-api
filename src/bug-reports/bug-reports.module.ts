import { Module } from '@nestjs/common';
import { DocumentsCoreModule } from '../documents/documents-core.module';
import { MailerCoreModule } from '../mailer/mailer-core.module';
import { AdminBugReportsController } from './admin-bug-reports.controller';
import {
  BugReportsRepository,
  SupabaseBugReportsRepository,
} from './bug-reports.repository';
import { BugReportsService } from './bug-reports.service';
import { MeBugReportsController } from './me-bug-reports.controller';

@Module({
  imports: [DocumentsCoreModule, MailerCoreModule],
  controllers: [MeBugReportsController, AdminBugReportsController],
  providers: [
    { provide: BugReportsRepository, useClass: SupabaseBugReportsRepository },
    BugReportsService,
  ],
})
export class BugReportsModule {}
