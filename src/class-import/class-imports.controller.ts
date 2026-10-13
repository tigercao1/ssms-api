import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Roles, RolesGuard } from '../admin/roles.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SupabaseJwtPayload } from '../auth/jwt-payload.interface';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { toActor } from '../audit/admin-actor';
import type {
  ClassImport,
  ClassImportDetail,
  CommitResult,
  EventMapping,
  EventMapResult,
} from './class-import.types';
import { ClassImportsService, type UploadedCsv } from './class-imports.service';
import {
  ClassImportQueryDto,
  SetEventMapDto,
  UpdateClassImportRowDto,
} from './dto/class-import.dto';

export const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024;

@Controller('admin/class-imports')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles('admin')
export class ClassImportsController {
  constructor(private readonly imports: ClassImportsService) {}

  @Get()
  list(): Promise<ClassImport[]> {
    return this.imports.list();
  }

  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_IMPORT_FILE_BYTES, files: 1 },
    }),
  )
  upload(
    @UploadedFile() file: UploadedCsv | undefined,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<ClassImportDetail> {
    return this.imports.upload(file, toActor(user, userAgent));
  }

  @Get('event-map')
  eventMap(): Promise<EventMapping[]> {
    return this.imports.eventMap();
  }

  @Put('event-map')
  setEventMap(
    @Body() dto: SetEventMapDto,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<EventMapResult> {
    return this.imports.setEventMap(dto.mappings, toActor(user, userAgent));
  }

  @Get(':id')
  get(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: ClassImportQueryDto,
  ): Promise<ClassImportDetail> {
    return this.imports.get(id, query.problem);
  }

  @Patch(':id/rows/:rowNo')
  updateRow(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('rowNo', ParseIntPipe) rowNo: number,
    @Body() dto: UpdateClassImportRowDto,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<ClassImportDetail> {
    return this.imports.updateRow(id, rowNo, dto, toActor(user, userAgent));
  }

  @Post(':id/commit')
  @HttpCode(HttpStatus.OK)
  commit(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<CommitResult> {
    return this.imports.commit(id, toActor(user, userAgent));
  }

  @Post(':id/discard')
  @HttpCode(HttpStatus.OK)
  discard(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<ClassImport> {
    return this.imports.discard(id, toActor(user, userAgent));
  }
}
