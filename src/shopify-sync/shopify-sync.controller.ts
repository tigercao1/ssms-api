import {
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  InstructorSyncService,
  type ReconcileResult,
} from './instructor-sync.service';
import { ReconcileAuthGuard } from './reconcile-auth.guard';

@Controller('internal/shopify-sync')
export class ShopifySyncController {
  constructor(private readonly sync: InstructorSyncService) {}

  @Post('reconcile')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ReconcileAuthGuard)
  reconcile(): Promise<ReconcileResult> {
    return this.sync.reconcile();
  }
}
