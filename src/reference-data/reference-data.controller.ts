import { Controller, Get } from '@nestjs/common';
import {
  ReferenceDataService,
  type ReferenceItem,
} from './reference-data.service';

/**
 * Public read-only reference-data endpoints used to populate frontend
 * dropdowns/multiselects. Each returns only `is_active = true` rows in a
 * deterministic sort order (see ReferenceDataService).
 *
 * These lists are non-sensitive shared lookups, so no auth guard is applied.
 */
@Controller('reference')
export class ReferenceDataController {
  constructor(private readonly referenceData: ReferenceDataService) {}

  @Get('teaching-locations')
  teachingLocations(): Promise<ReferenceItem[]> {
    return this.referenceData.getTeachingLocations();
  }

  @Get('languages')
  languages(): Promise<ReferenceItem[]> {
    return this.referenceData.getLanguages();
  }

  @Get('course-levels-offered')
  courseLevelsOffered(): Promise<ReferenceItem[]> {
    return this.referenceData.getCourseLevelsOffered();
  }

  @Get('exam-preparations')
  examPreparations(): Promise<ReferenceItem[]> {
    return this.referenceData.getExamPreparations();
  }
}
