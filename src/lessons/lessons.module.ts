import { Module } from '@nestjs/common';
import { GoogleModule } from '../google/google.module';
import { ClassesController } from './classes.controller';
import {
  ClassesRepository,
  SupabaseClassesRepository,
} from './classes.repository';
import { ClassesService } from './classes.service';
import { InstructorCalendarsController } from './instructor-calendars.controller';
import {
  InstructorCalendarsRepository,
  SupabaseInstructorCalendarsRepository,
} from './instructor-calendars.repository';
import { InstructorCalendarsService } from './instructor-calendars.service';
import { LessonTypesController } from './lesson-types.controller';
import {
  LessonTypesRepository,
  SupabaseLessonTypesRepository,
} from './lesson-types.repository';
import { LessonTypesService } from './lesson-types.service';
import { PayRatesController } from './pay-rates.controller';
import {
  PayRatesRepository,
  SupabasePayRatesRepository,
} from './pay-rates.repository';
import { PayRatesService } from './pay-rates.service';

@Module({
  imports: [GoogleModule],
  controllers: [
    LessonTypesController,
    PayRatesController,
    ClassesController,
    InstructorCalendarsController,
  ],
  providers: [
    { provide: LessonTypesRepository, useClass: SupabaseLessonTypesRepository },
    { provide: PayRatesRepository, useClass: SupabasePayRatesRepository },
    { provide: ClassesRepository, useClass: SupabaseClassesRepository },
    {
      provide: InstructorCalendarsRepository,
      useClass: SupabaseInstructorCalendarsRepository,
    },
    LessonTypesService,
    PayRatesService,
    ClassesService,
    InstructorCalendarsService,
  ],
  exports: [PayRatesService],
})
export class LessonsModule {}
