import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SeasonsService } from '../seasons/seasons.service';
import { DocumentSubjectsRepository } from './document-subjects.repository';
import type { DocumentInstructorRow } from './documents.types';
import {
  fillEmploymentLetter,
  readEmploymentLetterTemplate,
  renderEmploymentLetter,
} from './employment-letter-pdf';
import { INSTRUCTOR_PROFILE_NOT_FOUND } from './me-documents.service';
import { PdfWorkQueue } from './pdf-work-queue';

export const EMPLOYMENT_LETTER_FLAG = 'EMPLOYMENT_LETTER_ENABLED';
export const EMPLOYMENT_LETTER_DISABLED =
  'Employment letters are not available yet';
export const EMPLOYMENT_LETTER_NOT_ELIGIBLE =
  'Employment letters are only available to approved, active instructors';
export const LEGAL_NAME_REQUIRED =
  'Add your legal first and last name to your profile to get an employment letter';

export type EmploymentLetterState =
  | 'disabled'
  | 'not_eligible'
  | 'legal_name_missing'
  | 'ready';

export interface EmploymentLetterStatus {
  state: EmploymentLetterState;
  legalName: string | null;
}

export interface EmploymentLetterFile {
  filename: string;
  bytes: Uint8Array;
}

const LONG_DATE = new Intl.DateTimeFormat('en-CA', {
  dateStyle: 'long',
  timeZone: 'UTC',
});

function longDate(isoDate: string): string {
  return LONG_DATE.format(new Date(`${isoDate}T00:00:00Z`));
}

export function strictLegalName(
  row: Pick<DocumentInstructorRow, 'first_name' | 'last_name'>,
): string | null {
  const first = row.first_name?.trim();
  const last = row.last_name?.trim();
  return first && last ? `${first} ${last}` : null;
}

@Injectable()
export class EmploymentLetterService {
  constructor(
    private readonly config: ConfigService,
    private readonly subjects: DocumentSubjectsRepository,
    private readonly seasons: SeasonsService,
    private readonly pdfQueue: PdfWorkQueue,
  ) {}

  isEnabled(): boolean {
    return this.config.get<string>(EMPLOYMENT_LETTER_FLAG)?.trim() === 'true';
  }

  async status(authUserId: string): Promise<EmploymentLetterStatus> {
    if (!this.isEnabled()) {
      return { state: 'disabled', legalName: null };
    }
    const instructor = await this.findInstructor(authUserId);
    if (!instructor.is_active || instructor.approval_status !== 'approved') {
      return { state: 'not_eligible', legalName: null };
    }
    const legalName = strictLegalName(instructor);
    return legalName
      ? { state: 'ready', legalName }
      : { state: 'legal_name_missing', legalName: null };
  }

  async generate(authUserId: string): Promise<EmploymentLetterFile> {
    if (!this.isEnabled()) {
      throw new NotFoundException(EMPLOYMENT_LETTER_DISABLED);
    }
    const instructor = await this.findInstructor(authUserId);
    if (!instructor.is_active || instructor.approval_status !== 'approved') {
      throw new ForbiddenException(EMPLOYMENT_LETTER_NOT_ELIGIBLE);
    }
    const legalName = strictLegalName(instructor);
    if (!legalName) {
      throw new ConflictException(LEGAL_NAME_REQUIRED);
    }
    const today = this.seasons.today();
    const season = await this.seasons.current();
    const text = fillEmploymentLetter(await readEmploymentLetterTemplate(), {
      legal_name: legalName,
      issue_date: longDate(today),
      season: season?.key ?? '—',
      season_start: season ? longDate(season.starts_on) : '—',
      season_end: season ? longDate(season.ends_on) : '—',
      email: instructor.email,
    });
    const bytes = await this.pdfQueue.run(() => renderEmploymentLetter(text));
    return { filename: `employment-letter-${today}.pdf`, bytes };
  }

  private async findInstructor(
    authUserId: string,
  ): Promise<DocumentInstructorRow> {
    const instructor = await this.subjects.findInstructorByAuthUser(authUserId);
    if (!instructor) {
      throw new NotFoundException(INSTRUCTOR_PROFILE_NOT_FOUND);
    }
    return instructor;
  }
}
