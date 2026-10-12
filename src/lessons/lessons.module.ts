import { Module } from '@nestjs/common';
import { ShopifyModule } from '../shopify/shopify.module';
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
import { LessonProductSyncService } from './lesson-product-sync.service';
import { LessonProductsController } from './lesson-products.controller';
import {
  LessonProductsRepository,
  SupabaseLessonProductsRepository,
} from './lesson-products.repository';
import { LessonProductsService } from './lesson-products.service';
import { ShopifyLessonCatalog } from './shopify-lesson-catalog';

@Module({
  imports: [ShopifyModule],
  controllers: [
    LessonProductsController,
    ClassesController,
    InstructorCalendarsController,
  ],
  providers: [
    {
      provide: LessonProductsRepository,
      useClass: SupabaseLessonProductsRepository,
    },
    { provide: ClassesRepository, useClass: SupabaseClassesRepository },
    {
      provide: InstructorCalendarsRepository,
      useClass: SupabaseInstructorCalendarsRepository,
    },
    ShopifyLessonCatalog,
    LessonProductSyncService,
    LessonProductsService,
    ClassesService,
    InstructorCalendarsService,
  ],
})
export class LessonsModule {}
