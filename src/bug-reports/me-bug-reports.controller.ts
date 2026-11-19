import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { EmailVerifiedGuard } from '../auth/email-verified.guard';
import type { SupabaseJwtPayload } from '../auth/jwt-payload.interface';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { BugReportsService } from './bug-reports.service';
import type { ScreenshotUploadUrl } from './bug-reports.types';
import {
  ScreenshotUploadUrlDto,
  SubmitBugReportDto,
} from './dto/bug-report.dto';

@Controller('me/bug-reports')
@UseGuards(SupabaseAuthGuard, EmailVerifiedGuard)
export class MeBugReportsController {
  constructor(private readonly reports: BugReportsService) {}

  @Post('screenshot-url')
  @HttpCode(HttpStatus.OK)
  screenshotUrl(
    @Body() dto: ScreenshotUploadUrlDto,
    @CurrentUser() user: SupabaseJwtPayload,
  ): Promise<ScreenshotUploadUrl> {
    return this.reports.screenshotUploadUrl(user.sub, dto);
  }

  @Post()
  submit(
    @Body() dto: SubmitBugReportDto,
    @CurrentUser() user: SupabaseJwtPayload,
  ): Promise<{ id: string; createdAt: string }> {
    return this.reports.submit(user, dto);
  }
}
