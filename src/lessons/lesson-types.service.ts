import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ACTIONS, type AuditActor } from '../audit/audit.types';
import { hasCode, PG_UNIQUE_VIOLATION } from '../database/db-result';
import type {
  CreateLessonTypeDto,
  UpdateLessonTypeDto,
} from './dto/lesson-type.dto';
import {
  type LessonTypeRow,
  LessonTypesRepository,
  type LessonTypeWrite,
} from './lesson-types.repository';

export const LESSON_TYPE_NOT_FOUND = 'Lesson type not found';
export const LESSON_TYPE_NAME_TAKEN =
  'A lesson type with this English name already exists';
export const NOTHING_TO_UPDATE = 'Nothing to update';

export interface LessonType {
  id: string;
  nameEn: string;
  nameZh: string | null;
  groupSize: number | null;
  durationMin: number;
  isPromo: boolean;
  active: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

const FIELDS: [keyof UpdateLessonTypeDto, keyof LessonTypeWrite][] = [
  ['nameEn', 'name_en'],
  ['nameZh', 'name_zh'],
  ['groupSize', 'group_size'],
  ['durationMin', 'duration_min'],
  ['isPromo', 'is_promo'],
  ['active', 'active'],
  ['sortOrder', 'sort_order'],
];

export function toLessonType(row: LessonTypeRow): LessonType {
  return {
    id: row.id,
    nameEn: row.name_en,
    nameZh: row.name_zh,
    groupSize: row.group_size,
    durationMin: row.duration_min,
    isPromo: row.is_promo,
    active: row.active,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toWrite(dto: UpdateLessonTypeDto): LessonTypeWrite {
  const write: Record<string, unknown> = {};
  for (const [from, to] of FIELDS) {
    if (dto[from] !== undefined) {
      write[to] = from === 'nameZh' ? dto.nameZh || null : dto[from];
    }
  }
  return write;
}

@Injectable()
export class LessonTypesService {
  constructor(
    private readonly repo: LessonTypesRepository,
    private readonly audit: AuditService,
  ) {}

  async list(filter: { active?: boolean }): Promise<LessonType[]> {
    return (await this.repo.list(filter)).map(toLessonType);
  }

  async create(
    dto: CreateLessonTypeDto,
    actor: AuditActor,
  ): Promise<LessonType> {
    const row = await this.uniqueName(() =>
      this.repo.insert({
        ...toWrite(dto),
        name_en: dto.nameEn,
        duration_min: dto.durationMin,
      }),
    );
    await this.audit.record({
      action: AUDIT_ACTIONS.lessonTypeCreate,
      actor: { ...actor, role: 'admin' },
      targetType: 'lesson_type',
      targetId: row.id,
      metadata: { after: toLessonType(row) },
    });
    return toLessonType(row);
  }

  async update(
    id: string,
    dto: UpdateLessonTypeDto,
    actor: AuditActor,
  ): Promise<LessonType> {
    const patch = toWrite(dto);
    const fields = Object.keys(patch) as (keyof LessonTypeWrite)[];
    if (fields.length === 0) {
      throw new BadRequestException(NOTHING_TO_UPDATE);
    }
    const before = await this.repo.findById(id);
    if (!before) {
      throw new NotFoundException(LESSON_TYPE_NOT_FOUND);
    }
    const row = await this.uniqueName(() => this.repo.update(id, patch));
    if (!row) {
      throw new NotFoundException(LESSON_TYPE_NOT_FOUND);
    }
    await this.audit.record({
      action: AUDIT_ACTIONS.lessonTypeUpdate,
      actor: { ...actor, role: 'admin' },
      targetType: 'lesson_type',
      targetId: id,
      metadata: {
        before: Object.fromEntries(fields.map((f) => [f, before[f]])),
        after: Object.fromEntries(fields.map((f) => [f, row[f]])),
      },
    });
    return toLessonType(row);
  }

  private async uniqueName<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (err) {
      if (hasCode(err, PG_UNIQUE_VIOLATION)) {
        throw new ConflictException(LESSON_TYPE_NAME_TAKEN);
      }
      throw err;
    }
  }
}
