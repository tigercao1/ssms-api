import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../auth/current-user.decorator';
import { EmailVerifiedGuard } from '../auth/email-verified.guard';
import type { SupabaseJwtPayload } from '../auth/jwt-payload.interface';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import {
  InsuranceSeasonQueryDto,
  RegisterLessonDto,
} from './dto/insurance.dto';
import type { InsuranceRecord } from './insurance.presenters';
import {
  MeInsuranceService,
  type MyInsurance,
  type RegisterResult,
} from './me-insurance.service';

function respond(res: Response, result: RegisterResult): InsuranceRecord {
  res.status(result.created ? HttpStatus.CREATED : HttpStatus.OK);
  return result.record;
}

@Controller('me/insurance')
@UseGuards(SupabaseAuthGuard, EmailVerifiedGuard)
export class MeInsuranceController {
  constructor(private readonly insurance: MeInsuranceService) {}

  @Get()
  overview(
    @Query() query: InsuranceSeasonQueryDto,
    @CurrentUser() user: SupabaseJwtPayload,
  ): Promise<MyInsurance> {
    return this.insurance.overview(user.sub, query.season);
  }

  @Post('records')
  async register(
    @Body() dto: RegisterLessonDto,
    @CurrentUser() user: SupabaseJwtPayload,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InsuranceRecord> {
    return respond(res, await this.insurance.registerLesson(user.sub, dto));
  }
}
