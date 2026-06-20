import { Injectable, NotFoundException } from '@nestjs/common';
import {
  formatCertification,
  formatTrainerStatus,
} from '../instructors/cert-display.formatter';
import { ListInstructorsQueryDto } from './dto/list-instructors-query.dto';
import { pickLocalized, pickLocalizedNullable } from './locale.util';
import { PublicInstructorsRepository } from './public-instructors.repository';
import {
  PublicCertifications,
  PublicInstructorDto,
  PublicInstructorListDto,
  PublicRefItem,
} from './public-instructor.dto';
import {
  ListInstructorsParams,
  PublicCertRow,
  PublicInstructorRow,
  PublicRefRow,
  PublicTrainerRow,
} from './public-api.types';

/** Fixed page size (PUBLIC_API_PLAN.md § Pagination — LOCKED at 50). */
export const PAGE_SIZE = 50;

/** Group rows by `instructor_id` into a Map for O(1) per-instructor assembly. */
function groupBy<T extends { instructor_id: string }>(
  rows: T[],
): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const bucket = map.get(row.instructor_id);
    if (bucket) {
      bucket.push(row);
    } else {
      map.set(row.instructor_id, [row]);
    }
  }
  return map;
}

/**
 * Public instructor read service (T7.1–T7.6, T7.9).
 *
 * Composes the page of visible instructor ids (via the filtering/sorting RPC)
 * with their public relations and certifications, then maps everything to the
 * stable external DTO — localizing `display_name`/`bio` and hiding every
 * internal column.
 */
@Injectable()
export class PublicInstructorsService {
  constructor(private readonly repo: PublicInstructorsRepository) {}

  /** `GET /public/v1/instructors` — filtered, sorted, paginated list. */
  async list(query: ListInstructorsQueryDto): Promise<PublicInstructorListDto> {
    const params: ListInstructorsParams = {
      locale: query.locale,
      page: query.page,
      locations: query.location,
      languages: query.language,
      disciplines: query.discipline,
      minCsiaLevel: query.min_csia_level,
      minCasiLevel: query.min_casi_level,
      trainersOnly: query.trainers_only,
      sort: query.sort,
      order: query.order,
    };

    const { ids, totalCount } = await this.repo.listVisible(params);
    const data = await this.assemble(ids, query.locale);

    return {
      data,
      page: query.page,
      page_size: PAGE_SIZE,
      total_count: totalCount,
      total_pages: totalCount === 0 ? 0 : Math.ceil(totalCount / PAGE_SIZE),
    };
  }

  /** `GET /public/v1/instructors/:id` — single visible instructor, else 404. */
  async getById(
    id: string,
    locale: 'en' | 'zh-CN',
  ): Promise<PublicInstructorDto> {
    const row = await this.repo.findVisibleById(id);
    if (row === null) {
      throw new NotFoundException(`Instructor ${id} not found`);
    }
    const [dto] = await this.assembleFromRows([row], locale);
    return dto;
  }

  /**
   * Load public rows for `ids` then assemble DTOs in the SAME order as `ids`
   * (the RPC already sorted them). Instructors that fail re-fetch visibility are
   * silently dropped.
   */
  private async assemble(
    ids: string[],
    locale: 'en' | 'zh-CN',
  ): Promise<PublicInstructorDto[]> {
    if (ids.length === 0) {
      return [];
    }
    const rows = await this.repo.findVisibleByIds(ids);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const ordered = ids
      .map((id) => byId.get(id))
      .filter((r): r is PublicInstructorRow => r !== undefined);
    return this.assembleFromRows(ordered, locale);
  }

  /** Batch-fetch relations for the given rows and build their DTOs. */
  private async assembleFromRows(
    rows: PublicInstructorRow[],
    locale: 'en' | 'zh-CN',
  ): Promise<PublicInstructorDto[]> {
    const ids = rows.map((r) => r.id);
    const [locations, languages, courseLevels, certs, trainers] =
      await Promise.all([
        this.repo.getTeachingLocations(ids),
        this.repo.getLanguages(ids),
        this.repo.getCourseLevels(ids),
        this.repo.getCertifications(ids),
        this.repo.getTrainerStatus(ids),
      ]);

    const locationsBy = groupBy(locations);
    const languagesBy = groupBy(languages);
    const courseLevelsBy = groupBy(courseLevels);
    const certsBy = groupBy(certs);
    const trainersBy = groupBy(trainers);

    return rows.map((row) => ({
      id: row.id,
      display_name: pickLocalized(
        locale,
        row.display_name_en,
        row.display_name_zh,
      ),
      bio: pickLocalizedNullable(locale, row.bio_en, row.bio_zh),
      profile_photo_url: row.profile_photo_url,
      teaching_locations: toRefItems(locationsBy.get(row.id)),
      languages: toRefItems(languagesBy.get(row.id)),
      course_levels_offered: toRefItems(courseLevelsBy.get(row.id)),
      certifications: buildCertifications(
        certsBy.get(row.id) ?? [],
        trainersBy.get(row.id) ?? [],
      ),
    }));
  }
}

/** Map junction ref rows to sorted `{ key, label }` items. */
function toRefItems(rows: PublicRefRow[] | undefined): PublicRefItem[] {
  if (!rows || rows.length === 0) {
    return [];
  }
  return [...rows]
    .sort((a, b) => a.sort_order - b.sort_order || a.key.localeCompare(b.key))
    .map((r) => ({ key: r.key, label: r.name }));
}

/**
 * Build the nested `certifications` object (PUBLIC_API_PLAN.md § Response
 * shape). A discipline block is present only when the instructor holds a cert
 * for that org OR is a trainer in that discipline.
 */
function buildCertifications(
  certs: PublicCertRow[],
  trainers: PublicTrainerRow[],
): PublicCertifications {
  const result: PublicCertifications = {};

  const csia = certs.filter((c) => c.org === 'csia');
  const skiTrainer = trainers.find((t) => t.discipline === 'ski');
  const skiTrainerDisplay =
    skiTrainer && skiTrainer.trainer_level != null
      ? formatTrainerStatus({
          discipline: 'ski',
          trainerLevel: skiTrainer.trainer_level,
        })
      : null;
  if (csia.length > 0 || skiTrainerDisplay !== null) {
    result.ski = {
      regular: trackDisplay(csia, 'regular'),
      park: trackDisplay(csia, 'park'),
      trainer: skiTrainerDisplay,
    };
  }

  const casi = certs.filter((c) => c.org === 'casi');
  const sbTrainer = trainers.find((t) => t.discipline === 'snowboard');
  const sbTrainerDisplay =
    sbTrainer && sbTrainer.trainer_level != null
      ? formatTrainerStatus({
          discipline: 'snowboard',
          trainerLevel: sbTrainer.trainer_level,
        })
      : null;
  if (casi.length > 0 || sbTrainerDisplay !== null) {
    result.snowboard = {
      regular: trackDisplay(casi, 'regular'),
      park: trackDisplay(casi, 'park'),
      carving: trackDisplay(casi, 'carving'),
      trainer: sbTrainerDisplay,
    };
  }

  return result;
}

/** Format the display string for a given track, or null if not held. */
function trackDisplay(
  certs: PublicCertRow[],
  track: 'regular' | 'park' | 'carving',
): string | null {
  const cert = certs.find((c) => c.track === track);
  if (!cert) {
    return null;
  }
  return formatCertification({
    org: cert.org,
    track: cert.track,
    level: cert.level,
    isPartial: cert.is_partial,
  });
}
