export interface GlossaryEntry {
  readonly zh: readonly string[];
  readonly en: string;
}

export const TRANSLATION_GLOSSARY: readonly GlossaryEntry[] = [
  { zh: ['双板'], en: 'ski' },
  { zh: ['单板'], en: 'snowboard' },
  { zh: ['刻滑'], en: 'carving' },
  { zh: ['蘑菇'], en: 'moguls' },
  { zh: ['树林'], en: 'tree skiing' },
  { zh: ['公园'], en: 'park' },
  { zh: ['粉雪'], en: 'powder' },
  { zh: ['小回转'], en: 'short turns' },
  { zh: ['大回转'], en: 'long turns' },
  { zh: ['考证', '考前培训'], en: 'certification exam prep' },
  { zh: ['新手', '零基础'], en: 'beginner' },
  { zh: ['进阶'], en: 'intermediate' },
  { zh: ['高阶'], en: 'advanced' },
  { zh: ['少儿'], en: 'kids' },
  { zh: ['成人'], en: 'adults' },
  { zh: ['跟拍'], en: 'photo/video follow-cam' },
];

export const PRESERVED_TERMS: readonly string[] = [
  'CSIA',
  'CASI',
  'Level N',
  'Course Conductor',
];
