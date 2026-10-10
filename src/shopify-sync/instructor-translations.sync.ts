import { Injectable } from '@nestjs/common';
import type { EnglishTranslations } from './instructor-fields.builder';
import {
  ShopifyInstructorGateway,
  type TranslationInput,
} from './shopify-instructor.gateway';

export const TRANSLATION_LOCALE = 'en';

const TRANSLATED_KEYS: (keyof EnglishTranslations)[] = [
  'name',
  'introduction',
  'client_groups',
  'locations',
  'languages',
];

@Injectable()
export class InstructorTranslationsSync {
  constructor(private readonly gateway: ShopifyInstructorGateway) {}

  async apply(
    metaobjectId: string,
    desired: EnglishTranslations,
  ): Promise<void> {
    const resource = await this.gateway.translatableResource(
      metaobjectId,
      TRANSLATION_LOCALE,
    );
    if (!resource) {
      throw new Error(`Metaobject ${metaobjectId} is not translatable`);
    }
    const register: TranslationInput[] = [];
    const remove: string[] = [];
    for (const key of TRANSLATED_KEYS) {
      const value = desired[key];
      const content = resource.content.find((c) => c.key === key);
      const existing = resource.translations.find((t) => t.key === key);
      if (value !== null && content) {
        if (existing?.value !== value || existing.outdated) {
          register.push({
            key,
            value,
            locale: TRANSLATION_LOCALE,
            translatableContentDigest: content.digest,
          });
        }
      } else if (existing) {
        remove.push(key);
      }
    }
    if (register.length > 0) {
      await this.gateway.registerTranslations(metaobjectId, register);
    }
    if (remove.length > 0) {
      await this.gateway.removeTranslations(metaobjectId, remove, [
        TRANSLATION_LOCALE,
      ]);
    }
  }
}
