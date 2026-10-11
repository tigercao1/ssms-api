import { Module } from '@nestjs/common';
import { ShopifyModule } from '../shopify/shopify.module';
import { LessonProductSyncService } from './lesson-product-sync.service';
import { LessonProductsController } from './lesson-products.controller';
import {
  LessonProductsRepository,
  SupabaseLessonProductsRepository,
} from './lesson-products.repository';
import { ShopifyLessonCatalog } from './shopify-lesson-catalog';

@Module({
  imports: [ShopifyModule],
  controllers: [LessonProductsController],
  providers: [
    {
      provide: LessonProductsRepository,
      useClass: SupabaseLessonProductsRepository,
    },
    ShopifyLessonCatalog,
    LessonProductSyncService,
  ],
})
export class LessonsModule {}
