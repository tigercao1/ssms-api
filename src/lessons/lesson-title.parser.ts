import { baseHandle } from '../shopify-sync/instructor-handle';
import type { LessonSuggestion, LessonType } from './lessons.types';

export interface LessonTitleInput {
  productTitle: string;
  variantTitle: string | null;
  collectionHandles: readonly string[];
}

export interface InstructorHandleSource {
  id: string;
  displayNameEn: string;
  shopifyHandle: string | null;
}

export type InstructorHandleIndex = ReadonlyMap<string, string | null>;

const CHINESE_DIGITS: Record<string, number> = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

const NUMBER = '[0-9]+|[一二两三四五六七八九十]+';
const RATIO_PATTERN = new RegExp(
  `(?:一对|1\\s*对\\s*|1\\s*v\\s*)(${NUMBER})`,
  'gi',
);
const SESSIONS_PATTERN = new RegExp(`(单|${NUMBER})\\s*次`, 'g');
const HOURS_PATTERN = /([0-9]+(?:\.[0-9]+)?)\s*(?:小时|hours?|hrs?)/gi;
const MINUTES_PATTERN = /([0-9]+)\s*(?:分钟|min(?:ute)?s?)/gi;
const GROUP_MARKERS = ['团课', '小组课'];
const PER_STUDENT_MARKERS = ['每位学员', '每人'];

export function parseCount(text: string): number | null {
  if (/^[0-9]+$/.test(text)) {
    const value = Number(text);
    return value > 0 ? value : null;
  }
  const match = /^([一二两三四五六七八九])?(十)?([一二三四五六七八九])?$/.exec(
    text,
  );
  if (!match || text === '') {
    return null;
  }
  const [, lead, ten, unit] = match;
  if (!ten) {
    return lead && !unit ? CHINESE_DIGITS[lead] : null;
  }
  const tens = lead ? CHINESE_DIGITS[lead] : 1;
  return tens * 10 + (unit ? CHINESE_DIGITS[unit] : 0);
}

function distinct<T>(values: T[]): T | null {
  const unique = [...new Set(values)];
  return unique.length === 1 ? unique[0] : null;
}

function lessonShape(text: string): {
  lessonType: LessonType;
  groupSize: number | null;
} {
  const shapes: string[] = [];
  for (const match of text.matchAll(RATIO_PATTERN)) {
    const size = parseCount(match[1]);
    shapes.push(size === null ? 'other' : `ratio:${size}`);
  }
  if (GROUP_MARKERS.some((marker) => text.includes(marker))) {
    shapes.push('group');
  }
  const shape = distinct(shapes);
  if (shape === null || shape === 'other') {
    return { lessonType: 'other', groupSize: null };
  }
  if (shape === 'group') {
    return { lessonType: 'group', groupSize: null };
  }
  const size = Number(shape.slice('ratio:'.length));
  return {
    lessonType: size === 1 ? 'private' : 'semi_private',
    groupSize: size,
  };
}

function sessionCount(text: string): number | null {
  const counts = [...text.matchAll(SESSIONS_PATTERN)].map((match) =>
    match[1] === '单' ? 1 : parseCount(match[1]),
  );
  if (counts.includes(null)) {
    return null;
  }
  return distinct(counts);
}

function durationMinutes(text: string): number | null {
  const durations = [
    ...[...text.matchAll(HOURS_PATTERN)].map((m) =>
      Math.round(Number(m[1]) * 60),
    ),
    ...[...text.matchAll(MINUTES_PATTERN)].map((m) => Number(m[1])),
  ].filter((minutes) => minutes > 0);
  return distinct(durations);
}

export function buildInstructorHandleIndex(
  instructors: readonly InstructorHandleSource[],
): InstructorHandleIndex {
  const index = new Map<string, string | null>();
  const add = (handle: string, id: string) => {
    const key = handle.trim().toLowerCase();
    if (key === '') {
      return;
    }
    const existing = index.get(key);
    index.set(key, existing === undefined || existing === id ? id : null);
  };
  for (const instructor of instructors) {
    if (instructor.shopifyHandle) {
      add(instructor.shopifyHandle, instructor.id);
    }
    if (/[a-z0-9]/i.test(instructor.displayNameEn)) {
      add(baseHandle(instructor.id, instructor.displayNameEn), instructor.id);
    }
  }
  return index;
}

function instructorFor(
  collectionHandles: readonly string[],
  index: InstructorHandleIndex,
): string | null {
  const ids = collectionHandles
    .map((handle) => index.get(handle.trim().toLowerCase()))
    .filter((id) => id !== undefined);
  if (ids.includes(null)) {
    return null;
  }
  return distinct(ids as string[]);
}

export function suggestLessonProduct(
  input: LessonTitleInput,
  instructors: InstructorHandleIndex,
): LessonSuggestion {
  const text = [input.productTitle, input.variantTitle ?? '']
    .join(' ')
    .normalize('NFKC');
  const { lessonType, groupSize } = lessonShape(text);
  return {
    lessonType,
    groupSize,
    sessions: sessionCount(text),
    durationMin: durationMinutes(text),
    pricedPerStudent: PER_STUDENT_MARKERS.some((marker) =>
      text.includes(marker),
    ),
    instructorId: instructorFor(input.collectionHandles, instructors),
  };
}

export function isLessonCandidate(suggestion: LessonSuggestion): boolean {
  return suggestion.lessonType !== 'other' || suggestion.instructorId !== null;
}
