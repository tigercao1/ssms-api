import {
  Controller,
  Get,
  Header,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../auth/current-user.decorator';
import { EmailVerifiedGuard } from '../auth/email-verified.guard';
import type { SupabaseJwtPayload } from '../auth/jwt-payload.interface';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { PDF_CONTENT_TYPE } from './template-pdf';
import {
  EmploymentLetterService,
  type EmploymentLetterStatus,
} from './employment-letter.service';

@Controller('me/employment-letter')
@UseGuards(SupabaseAuthGuard, EmailVerifiedGuard)
export class MeEmploymentLetterController {
  constructor(private readonly letters: EmploymentLetterService) {}

  @Get()
  status(
    @CurrentUser() user: SupabaseJwtPayload,
  ): Promise<EmploymentLetterStatus> {
    return this.letters.status(user.sub);
  }

  @Get('letter.pdf')
  @Header('Cache-Control', 'no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async letter(
    @CurrentUser() user: SupabaseJwtPayload,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const file = await this.letters.generate(user.sub);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${file.filename}"`,
    );
    return new StreamableFile(file.bytes, {
      type: PDF_CONTENT_TYPE,
      length: file.bytes.length,
    });
  }
}
