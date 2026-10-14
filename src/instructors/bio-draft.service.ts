import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { BIO_TRANSLATOR } from '../bio-translation/bio-translator.interface';
import type { BioTranslator } from '../bio-translation/bio-translator.interface';
import { BioAiQuotaRepository, BioAiWindow } from './bio-ai-quota.repository';
import { BioDraftDto } from './dto/bio-draft.dto';
import { InstructorsRepository } from './instructors.repository';

export const BIO_AI_DAILY_LIMIT = 5;
export const BIO_AI_WINDOW_MS = 24 * 60 * 60 * 1000;
export const BIO_DRAFT_MAX_LENGTH = 1000;

export interface BioAiUsage {
  limit: number;
  used: number;
  remaining: number;
  resetsAt: string | null;
}

export interface BioDraftResponse {
  en: string;
  zh: string;
  model: string | null;
  usage: BioAiUsage;
}

export function toUsage(window: BioAiWindow): BioAiUsage {
  const used = Math.min(window.used, BIO_AI_DAILY_LIMIT);
  return {
    limit: BIO_AI_DAILY_LIMIT,
    used,
    remaining: BIO_AI_DAILY_LIMIT - used,
    resetsAt:
      used === 0 || window.oldestAt === null
        ? null
        : new Date(
            new Date(window.oldestAt).getTime() + BIO_AI_WINDOW_MS,
          ).toISOString(),
  };
}

/** Instructor bio refine / translate drafts with a rolling daily quota. */
@Injectable()
export class BioDraftService {
  private readonly logger = new Logger(BioDraftService.name);

  constructor(
    private readonly instructors: InstructorsRepository,
    private readonly quota: BioAiQuotaRepository,
    @Inject(BIO_TRANSLATOR) private readonly translator: BioTranslator,
  ) {}

  async getUsage(authUserId: string): Promise<BioAiUsage> {
    const instructorId = await this.instructorIdFor(authUserId);
    return toUsage(await this.quota.usage(instructorId));
  }

  async draft(authUserId: string, dto: BioDraftDto): Promise<BioDraftResponse> {
    const instructorId = await this.instructorIdFor(authUserId);
    if (!this.translator.draft || this.translator.modelId === null) {
      throw unavailable();
    }

    const reservation = await this.quota.reserve(
      instructorId,
      dto.mode,
      BIO_AI_DAILY_LIMIT,
    );
    const usage = toUsage(reservation);
    if (reservation.requestId === null) {
      throw new HttpException(
        { code: 'bio_ai_limit', usage },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    try {
      const draft = await this.translator.draft({
        text: dto.text.trim(),
        mode: dto.mode,
        maxLength: BIO_DRAFT_MAX_LENGTH,
      });
      return { ...draft, model: this.translator.modelId, usage };
    } catch (err) {
      this.logger.warn(
        `Bio ${dto.mode} draft failed for instructor ${instructorId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      await this.release(reservation.requestId);
      throw unavailable();
    }
  }

  private async release(requestId: string): Promise<void> {
    try {
      await this.quota.release(requestId);
    } catch (err) {
      this.logger.error(
        `Failed to release bio AI request ${requestId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async instructorIdFor(authUserId: string): Promise<string> {
    const instructor = await this.instructors.findByAuthUserId(authUserId);
    if (!instructor) {
      throw new NotFoundException('Instructor profile not found');
    }
    return instructor.id;
  }
}

function unavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException({ code: 'bio_ai_unavailable' });
}
