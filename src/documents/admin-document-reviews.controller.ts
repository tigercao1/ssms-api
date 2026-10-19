import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { Roles, RolesGuard } from '../admin/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { TOTAL_COUNT_HEADER } from '../config/cors';
import { AdminDocumentReviewsService } from './admin-document-reviews.service';
import type { DocumentReviewItem } from './document-reviews.types';
import { DocumentReviewsQueryDto } from './dto/document-review.dto';

@Controller('admin/document-reviews')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles('admin')
export class AdminDocumentReviewsController {
  constructor(private readonly reviews: AdminDocumentReviewsService) {}

  @Get()
  async list(
    @Query() query: DocumentReviewsQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DocumentReviewItem[]> {
    const { items, total } = await this.reviews.list(query);
    res.setHeader(TOTAL_COUNT_HEADER, String(total));
    return items;
  }
}
