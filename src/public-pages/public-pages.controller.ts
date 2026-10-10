import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Req,
  StreamableFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Request } from 'express';
import { Roles, RolesGuard } from '../admin/roles.guard';
import type { AuditActor } from '../audit/audit.types';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SupabaseJwtPayload } from '../auth/jwt-payload.interface';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { DocsStorageConfiguredGuard } from './docs-storage-configured.guard';
import { CreatePublicPageDto } from './dto/create-public-page.dto';
import { UpdatePublicPageDto } from './dto/update-public-page.dto';
import { PublicPagesService } from './public-pages.service';
import type { PublicPage } from './public-pages.types';
import { RawHtmlBodyInterceptor } from './raw-html-body.interceptor';

function toActor(user: SupabaseJwtPayload, userAgent?: string): AuditActor {
  return { userId: user.sub, role: 'admin', userAgent: userAgent ?? null };
}

const PageId = () => Param('id', new ParseUUIDPipe({ version: '4' }));

@Controller('admin/pages')
@UseGuards(SupabaseAuthGuard, RolesGuard, DocsStorageConfiguredGuard)
@Roles('admin')
export class PublicPagesController {
  constructor(private readonly pages: PublicPagesService) {}

  @Get()
  list(): Promise<PublicPage[]> {
    return this.pages.list();
  }

  @Post()
  create(
    @Body() dto: CreatePublicPageDto,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<PublicPage> {
    return this.pages.create(dto.slug, dto.title, toActor(user, userAgent));
  }

  @Patch(':id')
  update(
    @PageId() id: string,
    @Body() dto: UpdatePublicPageDto,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<PublicPage> {
    return this.pages.updateTitle(id, dto.title, toActor(user, userAgent));
  }

  @Put(':id/content')
  @UseInterceptors(RawHtmlBodyInterceptor)
  upload(
    @PageId() id: string,
    @Req() req: Request,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<PublicPage> {
    return this.pages.uploadContent(
      id,
      req.body as Buffer,
      toActor(user, userAgent),
    );
  }

  @Get(':id/content')
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Cache-Control', 'no-store')
  async content(@PageId() id: string): Promise<StreamableFile> {
    const body = await this.pages.getContent(id);
    return new StreamableFile(body, {
      type: 'text/plain; charset=utf-8',
      length: body.length,
    });
  }

  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  publish(
    @PageId() id: string,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<PublicPage> {
    return this.pages.publish(id, toActor(user, userAgent));
  }

  @Post(':id/unpublish')
  @HttpCode(HttpStatus.OK)
  unpublish(
    @PageId() id: string,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<PublicPage> {
    return this.pages.unpublish(id, toActor(user, userAgent));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @PageId() id: string,
    @CurrentUser() user: SupabaseJwtPayload,
    @Headers('user-agent') userAgent?: string,
  ): Promise<void> {
    return this.pages.remove(id, toActor(user, userAgent));
  }
}
