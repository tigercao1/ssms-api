import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyGuard } from './api-key.guard';
import { ListInstructorsQueryDto } from './dto/list-instructors-query.dto';
import {
  PublicInstructorDto,
  PublicInstructorListDto,
} from './public-instructor.dto';
import { PublicInstructorsService } from './public-instructors.service';

/**
 * Public, read-only instructor API for server-to-server consumers
 * (Shopify storefront backend, WeChat backend). Versioned from day one under
 * `/public/v1` (PUBLIC_API_PLAN.md). Every route requires a valid API key via
 * the `ApiKeyGuard` (Authorization: Bearer ssms_…) with per-key rate limiting.
 *
 * Only `approved` + `is_active` instructors are ever returned; internal columns
 * (email, DOB, approval_status, …) are never present in the DTO.
 */
@Controller('public/v1/instructors')
@UseGuards(ApiKeyGuard)
export class PublicInstructorsController {
  constructor(private readonly instructors: PublicInstructorsService) {}

  /** T7.1/4/5/6 — paginated, filterable, sortable list. */
  @Get()
  list(
    @Query() query: ListInstructorsQueryDto,
  ): Promise<PublicInstructorListDto> {
    return this.instructors.list(query);
  }

  /** T7.2 — single visible instructor; non-visible / unknown id → 404. */
  @Get(':id')
  getOne(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: ListInstructorsQueryDto,
  ): Promise<PublicInstructorDto> {
    return this.instructors.getById(id, query.locale);
  }
}
