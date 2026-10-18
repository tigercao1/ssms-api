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
  SubmitInsuranceRequestDto,
} from './dto/insurance.dto';
import type { InsuranceRecord, InsuranceRequest } from './insurance.presenters';
import { MeInsuranceService, type MyInsurance } from './me-insurance.service';

function respond<T>(res: Response, created: boolean, body: T): T {
  res.status(created ? HttpStatus.CREATED : HttpStatus.OK);
  return body;
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
    const { created, record } = await this.insurance.registerLesson(
      user.sub,
      dto,
    );
    return respond(res, created, record);
  }

  @Post('requests')
  async submitRequest(
    @Body() dto: SubmitInsuranceRequestDto,
    @CurrentUser() user: SupabaseJwtPayload,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InsuranceRequest> {
    const { created, request } = await this.insurance.submitRequest(
      user.sub,
      dto,
    );
    return respond(res, created, request);
  }
}
