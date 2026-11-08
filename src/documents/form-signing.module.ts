import { Module } from '@nestjs/common';
import { DocumentsCoreModule } from './documents-core.module';
import {
  FormSigningRepository,
  SupabaseFormSigningRepository,
} from './form-signing.repository';
import { FormSigningService } from './form-signing.service';
import { SignFormsController } from './sign-forms.controller';
import { SignFormsThrottlerGuard } from './sign-forms-throttler.guard';

@Module({
  imports: [DocumentsCoreModule],
  controllers: [SignFormsController],
  providers: [
    { provide: FormSigningRepository, useClass: SupabaseFormSigningRepository },
    FormSigningService,
    SignFormsThrottlerGuard,
  ],
})
export class FormSigningModule {}
