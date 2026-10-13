import { Module } from '@nestjs/common';
import { ClassImportsController } from './class-imports.controller';
import {
  ClassImportsRepository,
  SupabaseClassImportsRepository,
} from './class-imports.repository';
import { ClassImportsService } from './class-imports.service';

@Module({
  controllers: [ClassImportsController],
  providers: [
    {
      provide: ClassImportsRepository,
      useClass: SupabaseClassImportsRepository,
    },
    ClassImportsService,
  ],
})
export class ClassImportModule {}
