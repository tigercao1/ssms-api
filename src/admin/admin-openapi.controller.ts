import { Controller, Get, UseGuards } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { AdminOpenApiService } from './admin-openapi.service';
import { Roles, RolesGuard } from './roles.guard';

@Controller('admin')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles('admin')
export class AdminOpenApiController {
  constructor(private readonly openApi: AdminOpenApiService) {}

  @Get('openapi.json')
  getOpenApi(): Promise<OpenAPIObject> {
    return this.openApi.getDocument();
  }
}
