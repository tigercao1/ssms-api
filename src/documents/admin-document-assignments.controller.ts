import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Roles, RolesGuard } from '../admin/roles.guard';
import { toActor } from '../audit/admin-actor';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SupabaseJwtPayload } from '../auth/jwt-payload.interface';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { DocumentAssignmentsService } from './document-assignments.service';
import { DocumentSigningService } from './document-signing.service';
import type {
  Assignment,
  AssignmentResult,
  InstructorDocuments,
  SignedUrl,
} from './documents.types';
import { CreateAssignmentsDto } from './dto/assignment.dto';

/** Admin assignment routes: create, archive, and an instructor's documents. */
@Controller('admin')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles('admin')
export class AdminDocumentAssignmentsController {
  constructor(
    private readonly assignments: DocumentAssignmentsService,
    private readonly signing: DocumentSigningService,
  ) {}

  @Post('documents/assignments')
  create(
    @Body() dto: CreateAssignmentsDto,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<AssignmentResult> {
    return this.assignments.create(dto, toActor(user, userAgent));
  }

  @Post('documents/assignments/:id/archive')
  @HttpCode(HttpStatus.OK)
  archive(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<Assignment> {
    return this.assignments.archive(id, toActor(user, userAgent));
  }

  @Get('documents/assignments/:id/signed-url')
  signedUrl(@Param('id', new ParseUUIDPipe()) id: string): Promise<SignedUrl> {
    return this.signing.adminSignedUrl(id);
  }

  @Get('instructors/:id/documents')
  listForInstructor(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<InstructorDocuments> {
    return this.assignments.listForInstructor(id);
  }
}
