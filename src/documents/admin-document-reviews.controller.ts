import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Roles, RolesGuard } from '../admin/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { AdminDocumentReviewsService } from './admin-document-reviews.service';
import type { DocumentReviewItem } from './document-reviews.types';
import { DocumentReviewsQueryDto } from './dto/document-review.dto';

@Controller('admin/document-reviews')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles('admin')
export class AdminDocumentReviewsController {
  constructor(private readonly reviews: AdminDocumentReviewsService) {}

  @Get()
  list(@Query() query: DocumentReviewsQueryDto): Promise<DocumentReviewItem[]> {
    return this.reviews.list(query.status ?? 'pending');
  }
}
