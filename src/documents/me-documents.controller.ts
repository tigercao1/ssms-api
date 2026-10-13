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
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { clientIp } from '../activation/activation-throttler.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { EmailVerifiedGuard } from '../auth/email-verified.guard';
import type { SupabaseJwtPayload } from '../auth/jwt-payload.interface';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { DocumentSigningService } from './document-signing.service';
import type {
  Checklist,
  CompletedDocument,
  SignedUrl,
  SigningDocument,
} from './documents.types';
import { CompleteDocumentDto } from './dto/complete-document.dto';
import { MeDocumentsService } from './me-documents.service';

/** `/me/documents`: the calling instructor's onboarding checklist and documents. */
@Controller('me/documents')
@UseGuards(SupabaseAuthGuard, EmailVerifiedGuard)
export class MeDocumentsController {
  constructor(
    private readonly documents: MeDocumentsService,
    private readonly signing: DocumentSigningService,
  ) {}

  @Get()
  checklist(@CurrentUser() user: SupabaseJwtPayload): Promise<Checklist> {
    return this.documents.checklist(user.sub);
  }

  @Get(':assignmentId')
  open(
    @Param('assignmentId', new ParseUUIDPipe()) assignmentId: string,
    @CurrentUser() user: SupabaseJwtPayload,
  ): Promise<SigningDocument> {
    return this.signing.open(user.sub, assignmentId);
  }

  @Post(':assignmentId/complete')
  @HttpCode(HttpStatus.OK)
  complete(
    @Param('assignmentId', new ParseUUIDPipe()) assignmentId: string,
    @Body() dto: CompleteDocumentDto,
    @CurrentUser() user: SupabaseJwtPayload,
    @Req() req: Request,
    @Headers('user-agent') userAgent?: string,
  ): Promise<CompletedDocument> {
    return this.signing.complete(user.sub, assignmentId, dto, {
      ip: clientIp(req),
      userAgent: userAgent ?? null,
    });
  }

  @Get(':assignmentId/signed-url')
  signedUrl(
    @Param('assignmentId', new ParseUUIDPipe()) assignmentId: string,
    @CurrentUser() user: SupabaseJwtPayload,
  ): Promise<SignedUrl> {
    return this.signing.instructorSignedUrl(user.sub, assignmentId);
  }
}
