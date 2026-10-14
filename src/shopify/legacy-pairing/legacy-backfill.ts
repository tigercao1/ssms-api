import type { SupabaseClient } from '@supabase/supabase-js';
import { MAX_AVATAR_BYTES } from '../../media/dto/photo-upload-request.dto';
import type { LegacyEntry } from './legacy-our-team';
import { legacyEntryName } from './legacy-our-team';
import type { CompressedPhoto } from './photo-compression';
import { csvCell } from './pairing-csv';

export const BACKFILL_AUDIT_ACTION = 'system.legacy_backfill';
export const BIO_MAX_LENGTH = 1000;
export const DISPLAY_NAME_MAX_LENGTH = 100;

const PLACEHOLDER_BIOS = new Set([
  'tba',
  'tbd',
  'n/a',
  '-',
  '...',
  '无',
  '暂无',
]);
const HAN = /\p{Script=Han}/u;

export type TrainerDiscipline = 'ski' | 'snowboard';

export interface PhotoSlotSpec {
  field: 'picture' | 'image_1' | 'image_2';
  objectName: 'avatar' | 'photo-2' | 'photo-3';
  urlColumn: 'profile_photo_url' | 'photo_2_url' | 'photo_3_url';
  versionColumn:
    | 'profile_photo_version'
    | 'photo_2_version'
    | 'photo_3_version';
}

export const PHOTO_SLOTS: readonly PhotoSlotSpec[] = [
  {
    field: 'picture',
    objectName: 'avatar',
    urlColumn: 'profile_photo_url',
    versionColumn: 'profile_photo_version',
  },
  {
    field: 'image_1',
    objectName: 'photo-2',
    urlColumn: 'photo_2_url',
    versionColumn: 'photo_2_version',
  },
  {
    field: 'image_2',
    objectName: 'photo-3',
    urlColumn: 'photo_3_url',
    versionColumn: 'photo_3_version',
  },
];

export interface BackfillInstructor {
  id: string;
  display_name_en: string;
  display_name_zh: string | null;
  bio_en: string | null;
  bio_zh: string | null;
  display_order: number | null;
  profile_photo_url: string | null;
  photo_2_url: string | null;
  photo_3_url: string | null;
}

export interface ExistingTrainerStatus {
  discipline: TrainerDiscipline;
  trainer_level: number | null;
}

export interface LegacyTrainerParse {
  discipline: TrainerDiscipline | null;
  level: number | null;
  notes: string[];
}

export interface PlannedPhoto {
  slot: PhotoSlotSpec;
  sourceUrl: string;
  objectPath: string;
}

export interface InstructorBackfillPlan {
  instructorId: string;
  handle: string;
  name: string;
  legacyCertification: string;
  update: Record<string, string | number | boolean | null>;
  photos: PlannedPhoto[];
  translateBioToEn: string | null;
  trainer: { discipline: TrainerDiscipline; level: number } | null;
  notes: string[];
}

function fieldValue(entry: LegacyEntry, key: string): string {
  return (entry.fields.find((f) => f.key === key)?.value ?? '').trim();
}

function imageUrl(entry: LegacyEntry, key: string): string | null {
  const reference = entry.fields.find((f) => f.key === key)?.reference as
    | { image?: { url?: string } | null }
    | null
    | undefined;
  const url = reference?.image?.url;
  return url ? url.split('?')[0] : null;
}

function englishTranslation(entry: LegacyEntry, key: string): string {
  return (
    entry.translations.find((t) => t.key === key && t.locale === 'en')?.value ??
    ''
  ).trim();
}

export function isMeaningfulBio(value: string): boolean {
  const text = value.trim();
  return text.length > 0 && !PLACEHOLDER_BIOS.has(text.toLowerCase());
}

export function parseLegacyTrainer(certification: string): LegacyTrainerParse {
  const parts = certification
    .split(/[|｜]/)
    .map((p) => p.trim())
    .filter(Boolean);
  const notes: string[] = [];
  let level: number | null = null;
  let bareTrainer = false;
  for (const part of parts) {
    const conductor = /^course conductor level\s*(\d)$/i.exec(part);
    if (conductor) {
      level = Math.max(level ?? 0, Number(conductor[1]));
    } else if (/^trainer$/i.test(part)) {
      bareTrainer = true;
    } else if (/trainer|conductor/i.test(part)) {
      notes.push(`unmapped trainer credential "${part}"`);
    }
  }
  if (level === null && bareTrainer) {
    level = 1;
  }
  if (level === null) {
    return { discipline: null, level: null, notes };
  }
  if (level < 1 || level > 4) {
    notes.push(`trainer level ${level} is outside 1-4`);
    return { discipline: null, level: null, notes };
  }
  const csia = /csia/i.test(certification);
  const casi = /casi/i.test(certification);
  if (csia === casi) {
    notes.push(
      `trainer level ${level} found but discipline is ambiguous in "${certification}"`,
    );
    return { discipline: null, level: null, notes };
  }
  return { discipline: csia ? 'ski' : 'snowboard', level, notes };
}

export function planInstructorBackfill(
  entry: LegacyEntry,
  instructor: BackfillInstructor,
  trainerRows: ExistingTrainerStatus[],
): InstructorBackfillPlan {
  const notes: string[] = [];
  const update: InstructorBackfillPlan['update'] = {};
  let translateBioToEn: string | null = null;

  const photos: PlannedPhoto[] = [];
  for (const slot of PHOTO_SLOTS) {
    const sourceUrl = imageUrl(entry, slot.field);
    if (sourceUrl) {
      photos.push({
        slot,
        sourceUrl,
        objectPath: `${instructor.id}/${slot.objectName}.jpg`,
      });
    }
  }

  const bioZh = fieldValue(entry, 'introduction');
  const bioEn = englishTranslation(entry, 'introduction');
  if (!isMeaningfulBio(bioZh)) {
    notes.push(
      bioZh
        ? `legacy bio "${bioZh}" is a placeholder; bios left as is`
        : 'no legacy bio',
    );
  } else if (bioZh.length > BIO_MAX_LENGTH) {
    notes.push(
      `legacy bio is ${bioZh.length} characters, over ${BIO_MAX_LENGTH}; bios left as is`,
    );
  } else {
    update.bio_zh = bioZh;
    update.bio_zh_machine_translated = false;
    update.bio_zh_translated_by = null;
    if (isMeaningfulBio(bioEn) && bioEn.length <= BIO_MAX_LENGTH) {
      update.bio_en = bioEn;
      update.bio_en_machine_translated = false;
      update.bio_en_translated_by = null;
    } else {
      update.bio_en = null;
      update.bio_en_machine_translated = false;
      update.bio_en_translated_by = null;
      translateBioToEn = bioZh;
    }
  }

  const legacyName = legacyEntryName(entry);
  if (HAN.test(legacyName) && legacyName.length <= DISPLAY_NAME_MAX_LENGTH) {
    if (legacyName !== (instructor.display_name_zh ?? '')) {
      update.display_name_zh = legacyName;
    }
  }

  const sortOrder = fieldValue(entry, 'sort_order');
  if (/^\d+$/.test(sortOrder)) {
    const order = Number(sortOrder);
    if (order !== instructor.display_order) {
      update.display_order = order;
    }
  }

  const certification = fieldValue(entry, 'certification');
  const parsed = parseLegacyTrainer(certification);
  notes.push(...parsed.notes);
  let trainer: InstructorBackfillPlan['trainer'] = null;
  if (parsed.discipline && parsed.level) {
    const existing = trainerRows.find(
      (t) => t.discipline === parsed.discipline,
    );
    if ((existing?.trainer_level ?? 0) >= parsed.level) {
      notes.push(
        `trainer level ${parsed.level} (${parsed.discipline}) not applied; SSMS already has level ${existing?.trainer_level}`,
      );
    } else {
      trainer = { discipline: parsed.discipline, level: parsed.level };
    }
  }

  return {
    instructorId: instructor.id,
    handle: entry.handle,
    name: instructor.display_name_en,
    legacyCertification: certification,
    update,
    photos,
    translateBioToEn,
    trainer,
    notes,
  };
}

export interface BackfillIo {
  supabase: SupabaseClient;
  bucket: string;
  fetchBytes: (url: string) => Promise<Buffer>;
  compress: (bytes: Buffer) => Promise<CompressedPhoto>;
  log: (line: string) => void;
}

export interface PhotoResult {
  field: string;
  originalBytes: number;
  compressedBytes: number;
  width: number;
  height: number;
  objectPath: string;
  bytes: Buffer;
  contentType: string;
}

export async function preparePhotos(
  io: BackfillIo,
  plan: InstructorBackfillPlan,
): Promise<PhotoResult[]> {
  const results: PhotoResult[] = [];
  for (const photo of plan.photos) {
    const original = await io.fetchBytes(photo.sourceUrl);
    const compressed = await io.compress(original);
    if (compressed.bytes.length > MAX_AVATAR_BYTES) {
      throw new Error(
        `${plan.handle} ${photo.slot.field}: compressed photo is ${compressed.bytes.length} bytes, over the ${MAX_AVATAR_BYTES} byte limit`,
      );
    }
    results.push({
      field: photo.slot.field,
      originalBytes: original.length,
      compressedBytes: compressed.bytes.length,
      width: compressed.width,
      height: compressed.height,
      objectPath: photo.objectPath,
      bytes: compressed.bytes,
      contentType: compressed.contentType,
    });
  }
  return results;
}

function objectPathFromPublicUrl(
  url: string | null,
  bucket: string,
): string | null {
  if (!url) {
    return null;
  }
  const marker = `/storage/v1/object/public/${bucket}/`;
  const index = url.indexOf(marker);
  return index === -1
    ? null
    : decodeURIComponent(url.slice(index + marker.length).split('?')[0]);
}

export async function applyInstructorBackfill(
  io: BackfillIo,
  plan: InstructorBackfillPlan,
  instructor: BackfillInstructor,
  photos: PhotoResult[],
  now: Date,
): Promise<void> {
  const { supabase, bucket } = io;
  const update: Record<string, unknown> = { ...plan.update };
  const replacedObjects: string[] = [];

  for (const photo of photos) {
    const slot = PHOTO_SLOTS.find((s) => s.field === photo.field)!;
    const { error } = await supabase.storage
      .from(bucket)
      .upload(photo.objectPath, photo.bytes, {
        contentType: photo.contentType,
        upsert: true,
      });
    if (error) {
      throw new Error(
        `${plan.handle} ${photo.field}: upload failed: ${error.message}`,
      );
    }
    update[slot.urlColumn] = supabase.storage
      .from(bucket)
      .getPublicUrl(photo.objectPath).data.publicUrl;
    update[slot.versionColumn] = now.toISOString();
    const previous = objectPathFromPublicUrl(
      instructor[slot.urlColumn],
      bucket,
    );
    if (previous && previous !== photo.objectPath) {
      replacedObjects.push(previous);
    }
  }

  if (Object.keys(update).length > 0) {
    const { error } = await supabase
      .from('instructors')
      .update(update)
      .eq('id', plan.instructorId);
    if (error) {
      throw new Error(
        `${plan.handle}: instructor update failed: ${error.message}`,
      );
    }
  }

  if (replacedObjects.length > 0) {
    const { error } = await supabase.storage
      .from(bucket)
      .remove(replacedObjects);
    if (error) {
      io.log(
        `  warning: could not remove replaced photos ${replacedObjects.join(', ')}: ${error.message}`,
      );
    }
  }

  if (plan.trainer) {
    const { data: existing, error: readError } = await supabase
      .from('instructor_trainer_status')
      .select('id')
      .eq('instructor_id', plan.instructorId)
      .eq('discipline', plan.trainer.discipline)
      .maybeSingle();
    if (readError) {
      throw new Error(
        `${plan.handle}: trainer status read failed: ${readError.message}`,
      );
    }
    const { error } = existing
      ? await supabase
          .from('instructor_trainer_status')
          .update({ trainer_level: plan.trainer.level })
          .eq('id', existing.id)
      : await supabase.from('instructor_trainer_status').insert({
          instructor_id: plan.instructorId,
          discipline: plan.trainer.discipline,
          trainer_level: plan.trainer.level,
          rookie_session_completed: false,
          trainer_exam_passed: false,
        });
    if (error) {
      throw new Error(
        `${plan.handle}: trainer status write failed: ${error.message}`,
      );
    }
  }

  if (plan.translateBioToEn) {
    const { error: clearError } = await supabase
      .from('bio_translation_jobs')
      .delete()
      .eq('instructor_id', plan.instructorId)
      .eq('target_lang', 'en')
      .in('status', ['pending', 'processing']);
    if (clearError) {
      throw new Error(
        `${plan.handle}: clearing translation jobs failed: ${clearError.message}`,
      );
    }
    const { error } = await supabase.from('bio_translation_jobs').insert({
      instructor_id: plan.instructorId,
      source_lang: 'zh-CN',
      target_lang: 'en',
      source_text: plan.translateBioToEn,
    });
    if (error) {
      throw new Error(
        `${plan.handle}: translation enqueue failed: ${error.message}`,
      );
    }
  }

  const before = Object.fromEntries(
    Object.keys(update)
      .filter((k) => k in instructor)
      .map((k) => [k, instructor[k as keyof BackfillInstructor]]),
  );
  const { error: auditError } = await supabase.from('audit_log').insert({
    actor_role: 'system',
    action: BACKFILL_AUDIT_ACTION,
    target_type: 'instructor',
    target_id: plan.instructorId,
    metadata: {
      legacy_handle: plan.handle,
      before,
      after: update,
      trainer: plan.trainer,
      translation_enqueued: plan.translateBioToEn !== null,
      photos: photos.map((p) => ({
        field: p.field,
        original_bytes: p.originalBytes,
        stored_bytes: p.compressedBytes,
        width: p.width,
        height: p.height,
      })),
      replaced_objects: replacedObjects,
    },
  });
  if (auditError) {
    throw new Error(
      `${plan.handle}: audit log write failed: ${auditError.message}`,
    );
  }
}

export const BACKFILL_REPORT_COLUMNS = [
  'handle',
  'instructor_id',
  'name',
  'field',
  'current',
  'new',
] as const;

type ReportValue = string | number | boolean | null | undefined;

function short(value: ReportValue): string {
  if (value === null || value === undefined) {
    return '';
  }
  const text = `${value}`;
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

export function formatBackfillReport(
  rows: {
    plan: InstructorBackfillPlan;
    instructor: BackfillInstructor;
    photos: PhotoResult[];
  }[],
): string {
  const lines = [BACKFILL_REPORT_COLUMNS.join(',')];
  const push = (
    plan: InstructorBackfillPlan,
    field: string,
    current: ReportValue,
    next: ReportValue,
  ) =>
    lines.push(
      [
        plan.handle,
        plan.instructorId,
        plan.name,
        field,
        short(current),
        short(next),
      ]
        .map(csvCell)
        .join(','),
    );
  for (const { plan, instructor, photos } of rows) {
    for (const photo of photos) {
      const slot = PHOTO_SLOTS.find((s) => s.field === photo.field)!;
      push(
        plan,
        slot.urlColumn,
        instructor[slot.urlColumn],
        `${photo.objectPath} (${photo.width}x${photo.height}, ${Math.round(photo.originalBytes / 1024)} KB -> ${Math.round(photo.compressedBytes / 1024)} KB)`,
      );
    }
    for (const [key, value] of Object.entries(plan.update)) {
      if (
        key.endsWith('_machine_translated') ||
        key.endsWith('_translated_by')
      ) {
        continue;
      }
      push(plan, key, instructor[key as keyof BackfillInstructor], value);
    }
    if (plan.translateBioToEn) {
      push(plan, 'bio_en', '', '(machine translation queued)');
    }
    if (plan.trainer) {
      push(
        plan,
        'trainer_level',
        '',
        `${plan.trainer.discipline} level ${plan.trainer.level}, rookie session off`,
      );
    }
    if (plan.legacyCertification) {
      push(
        plan,
        'legacy_certification (report only)',
        '',
        plan.legacyCertification,
      );
    }
    for (const note of plan.notes) {
      push(plan, 'note', '', note);
    }
  }
  return `${lines.join('\n')}\n`;
}
