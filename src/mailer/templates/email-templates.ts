import {
  interpolate,
  type EmailButtonCopy,
  type EmailCopy,
  type MessageCatalog,
  type SupportedLanguage,
} from '../../i18n';
import type { Vars } from '../../i18n';
import type {
  EmailDocumentTitle,
  EmailTemplate,
  EmailTemplateVars,
} from '../mailer.types';

/** One language's worth of an email, as plain strings (escaped at layout time). */
export interface EmailBlocks {
  subject: string;
  preheader: string;
  heading: string;
  greeting: string | null;
  paragraphs: string[];
  code?: { label: string | null; value: string };
  button?: { label: string; url: string };
  /** A long identifier (e.g. a SHA-256) shown small and monospaced. */
  fingerprint?: { label: string; value: string };
  finePrint: string;
}

/** Values the preview samples build links from. */
export interface SampleContext {
  portalUrl: string;
}

export interface TemplateDefinition<T extends EmailTemplate> {
  build(
    catalog: MessageCatalog,
    vars: EmailTemplateVars[T],
    language: SupportedLanguage,
  ): EmailBlocks;
  sample(context: SampleContext): EmailTemplateVars[T];
}

type TemplateRegistry = { [T in EmailTemplate]: TemplateDefinition<T> };

const SAMPLE_CODE = '48291736';
const SAMPLE_NAME = 'Lin Wei';
const SAMPLE_SEASON = '2026/27';
const SAMPLE_VALID_DAYS = 30;

function toVars(vars: object): Vars {
  const out: Vars = {};
  for (const [key, value] of Object.entries(vars)) {
    if (typeof value === 'string' || typeof value === 'number') {
      out[key] = value;
    }
  }
  return out;
}

function fill(
  copy: EmailCopy,
  vars: object,
): Omit<EmailBlocks, 'greeting' | 'code' | 'button'> {
  const values = toVars(vars);
  return {
    subject: interpolate(copy.subject, values),
    preheader: interpolate(copy.preheader, values),
    heading: interpolate(copy.heading, values),
    paragraphs: copy.paragraphs.map((p) => interpolate(p, values)),
    finePrint: interpolate(copy.finePrint, values),
  };
}

function greet(catalog: MessageCatalog, name?: string | null): string {
  const trimmed = name?.trim();
  return trimmed
    ? interpolate(catalog.email.layout.greeting, { name: trimmed })
    : catalog.email.layout.greetingNoName;
}

function optionalCode(
  catalog: MessageCatalog,
  code?: string | null,
): EmailBlocks['code'] {
  const value = code?.trim();
  return value ? { label: catalog.email.layout.codeLabel, value } : undefined;
}

function documentTitle(
  document: EmailDocumentTitle,
  language: SupportedLanguage,
): string {
  const zh = document.titleZh?.trim();
  return language === 'zh-CN' && zh ? zh : document.titleEn;
}

function documentList(
  catalog: MessageCatalog,
  copy: EmailCopy & { button: string },
  vars: EmailTemplateVars['documents.assigned'],
  language: SupportedLanguage,
): EmailBlocks {
  const blocks = fill(copy, { count: vars.documents.length });
  const [intro, ...rest] = blocks.paragraphs;
  return {
    ...blocks,
    greeting: greet(catalog, vars.displayName),
    paragraphs: [
      intro,
      ...vars.documents.map((d) => `• ${documentTitle(d, language)}`),
      ...rest,
    ],
    button: { label: copy.button, url: vars.onboardingUrl },
  };
}

const SAMPLE_DOCUMENTS: EmailDocumentTitle[] = [
  { titleEn: 'Instructor agreement', titleZh: '教练协议' },
  { titleEn: 'Safety policy', titleZh: '安全守则' },
];
const SAMPLE_SHA256 =
  '3b7e1f0c9a4d2e8b6f5a1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f';

type CertificationExpiryVars =
  EmailTemplateVars['certification.expiring'];

function certificationExpiryBlocks(
  catalog: MessageCatalog,
  copy: EmailButtonCopy,
  vars: CertificationExpiryVars,
): EmailBlocks {
  const certification = interpolate(
    catalog.email.certification.labels[vars.track],
    { org: vars.org.toUpperCase(), level: vars.level },
  );
  return {
    ...fill(copy, { ...vars, certification }),
    greeting: greet(catalog, vars.displayName),
    button: { label: copy.button, url: vars.uploadUrl },
  };
}

function sampleCertificationExpiry({
  portalUrl,
}: SampleContext): CertificationExpiryVars {
  return {
    displayName: SAMPLE_NAME,
    org: 'csia',
    track: 'regular',
    level: 2,
    validUntil: '2026-11-30',
    uploadUrl: `${portalUrl}/onboarding`,
  };
}

const SAMPLE_SUPABASE_URL = 'https://example.supabase.co';

function sampleVerifyUrl(context: SampleContext, type: string): string {
  const redirectTo = encodeURIComponent(`${context.portalUrl}/login`);
  return `${SAMPLE_SUPABASE_URL}/auth/v1/verify?token=sample-token-hash&type=${type}&redirect_to=${redirectTo}`;
}

/**
 * Every {@link EmailTemplate}: how its vars become content blocks (copy from
 * the i18n catalog, `email.*`) and the sample vars the admin preview uses.
 */
export const EMAIL_TEMPLATES: TemplateRegistry = {
  approved: {
    build: (catalog, vars) => {
      const copy = catalog.email.approved;
      return {
        ...fill(copy, vars),
        greeting: greet(catalog, vars.displayName),
        button: { label: copy.button, url: vars.loginUrl },
      };
    },
    sample: ({ portalUrl }) => ({
      displayName: SAMPLE_NAME,
      loginUrl: `${portalUrl}/login`,
    }),
  },
  rejected: {
    build: (catalog, vars) => {
      const copy = catalog.email.rejected;
      const blocks = fill(copy, vars);
      const reason = vars.reason?.trim();
      return {
        ...blocks,
        greeting: greet(catalog, vars.displayName),
        paragraphs: [
          ...blocks.paragraphs,
          ...(reason ? [`${copy.reasonLabel} ${reason}`] : []),
          copy.closing,
        ],
      };
    },
    sample: () => ({
      displayName: SAMPLE_NAME,
      reason:
        'Please add your current CSIA or CASI certification so we can verify your level.',
    }),
  },
  deactivated: {
    build: (catalog, vars) => ({
      ...fill(catalog.email.deactivated, vars),
      greeting: greet(catalog, vars.displayName),
    }),
    sample: () => ({ displayName: SAMPLE_NAME }),
  },
  reactivated: {
    build: (catalog, vars) => {
      const copy = catalog.email.reactivated;
      return {
        ...fill(copy, vars),
        greeting: greet(catalog, vars.displayName),
        button: { label: copy.button, url: vars.loginUrl },
      };
    },
    sample: ({ portalUrl }) => ({
      displayName: SAMPLE_NAME,
      loginUrl: `${portalUrl}/login`,
    }),
  },
  'auth.confirm_signup': {
    build: (catalog, vars) => {
      const copy = catalog.email.auth.confirmSignup;
      return {
        ...fill(copy, vars),
        greeting: null,
        button: { label: copy.button, url: vars.confirmUrl },
        code: optionalCode(catalog, vars.code),
      };
    },
    sample: (context) => ({
      confirmUrl: sampleVerifyUrl(context, 'signup'),
    }),
  },
  'auth.recovery': {
    build: (catalog, vars) => {
      const copy = catalog.email.auth.recovery;
      return {
        ...fill(copy, vars),
        greeting: null,
        button: { label: copy.button, url: vars.resetUrl },
        code: optionalCode(catalog, vars.code),
      };
    },
    sample: (context) => ({
      resetUrl: sampleVerifyUrl(context, 'recovery'),
    }),
  },
  'auth.magic_link': {
    build: (catalog, vars) => {
      const copy = catalog.email.auth.magicLink;
      return {
        ...fill(copy, vars),
        greeting: null,
        button: { label: copy.button, url: vars.signInUrl },
        code: optionalCode(catalog, vars.code),
      };
    },
    sample: (context) => ({
      signInUrl: sampleVerifyUrl(context, 'magiclink'),
    }),
  },
  'auth.invite': {
    build: (catalog, vars) => {
      const copy = catalog.email.auth.invite;
      return {
        ...fill(copy, vars),
        greeting: null,
        button: { label: copy.button, url: vars.acceptUrl },
      };
    },
    sample: (context) => ({ acceptUrl: sampleVerifyUrl(context, 'invite') }),
  },
  'auth.email_change': {
    build: (catalog, vars) => {
      const copy = catalog.email.auth.emailChange;
      return {
        ...fill(copy, vars),
        greeting: null,
        button: { label: copy.button, url: vars.confirmUrl },
        code: optionalCode(catalog, vars.code),
      };
    },
    sample: (context) => ({
      confirmUrl: sampleVerifyUrl(context, 'email_change'),
      newEmail: 'lin.wei@example.com',
    }),
  },
  'auth.reauthentication': {
    build: (catalog, vars) => ({
      ...fill(catalog.email.auth.reauthentication, vars),
      greeting: null,
      code: { label: null, value: vars.code },
    }),
    sample: () => ({ code: SAMPLE_CODE }),
  },
  'auth.password_changed': {
    build: (catalog, vars) => ({
      ...fill(catalog.email.auth.passwordChanged, vars),
      greeting: null,
    }),
    sample: () => ({}),
  },
  'auth.email_changed': {
    build: (catalog, vars) => ({
      ...fill(catalog.email.auth.emailChanged, vars),
      greeting: null,
    }),
    sample: () => ({
      oldEmail: 'lin.wei@example.com',
      newEmail: 'lin.wei@example.org',
    }),
  },
  'auth.phone_changed': {
    build: (catalog, vars) => ({
      ...fill(catalog.email.auth.phoneChanged, vars),
      greeting: null,
    }),
    sample: () => ({}),
  },
  'auth.identity_linked': {
    build: (catalog, vars) => ({
      ...fill(catalog.email.auth.identityLinked, vars),
      greeting: null,
    }),
    sample: () => ({ provider: 'google' }),
  },
  'auth.identity_unlinked': {
    build: (catalog, vars) => ({
      ...fill(catalog.email.auth.identityUnlinked, vars),
      greeting: null,
    }),
    sample: () => ({ provider: 'google' }),
  },
  'auth.mfa_enrolled': {
    build: (catalog, vars) => ({
      ...fill(catalog.email.auth.mfaEnrolled, vars),
      greeting: null,
    }),
    sample: () => ({ factorType: 'totp' }),
  },
  'auth.mfa_unenrolled': {
    build: (catalog, vars) => ({
      ...fill(catalog.email.auth.mfaUnenrolled, vars),
      greeting: null,
    }),
    sample: () => ({ factorType: 'totp' }),
  },
  'auth.generic': {
    build: (catalog, vars) => {
      const copy = catalog.email.auth.generic;
      const blocks = fill(copy, vars);
      const url = vars.actionUrl?.trim();
      if (!url) {
        return { ...blocks, greeting: null };
      }
      return {
        ...blocks,
        greeting: null,
        paragraphs: [...blocks.paragraphs, copy.linkParagraph],
        button: { label: copy.button, url },
      };
    },
    sample: (context) => ({
      actionUrl: sampleVerifyUrl(context, 'signup'),
    }),
  },
  'invite.season': {
    build: (catalog, vars) => {
      const copy = catalog.email.invite.season;
      return {
        ...fill(copy, vars),
        greeting: greet(catalog, vars.displayName),
        button: { label: copy.button, url: vars.activateUrl },
      };
    },
    sample: ({ portalUrl }) => ({
      displayName: SAMPLE_NAME,
      season: SAMPLE_SEASON,
      activateUrl: `${portalUrl}/activate?t=sample-token`,
      validDays: SAMPLE_VALID_DAYS,
    }),
  },
  'invite.reminder': {
    build: (catalog, vars) => {
      const copy = catalog.email.invite.reminder;
      return {
        ...fill(copy, vars),
        greeting: greet(catalog, vars.displayName),
        button: { label: copy.button, url: vars.activateUrl },
      };
    },
    sample: ({ portalUrl }) => ({
      displayName: SAMPLE_NAME,
      season: SAMPLE_SEASON,
      activateUrl: `${portalUrl}/activate?t=sample-token`,
      validDays: SAMPLE_VALID_DAYS,
    }),
  },
  'certification.expiring': {
    build: (catalog, vars) =>
      certificationExpiryBlocks(
        catalog,
        catalog.email.certification.expiring,
        vars,
      ),
    sample: sampleCertificationExpiry,
  },
  'certification.expired': {
    build: (catalog, vars) =>
      certificationExpiryBlocks(
        catalog,
        catalog.email.certification.expired,
        vars,
      ),
    sample: sampleCertificationExpiry,
  },
  'admin.instructor_pending': {
    build: (catalog, vars) => {
      const copy = catalog.email.admin.instructorPending;
      return {
        ...fill(copy, vars),
        greeting: greet(catalog),
        button: { label: copy.button, url: vars.reviewUrl },
      };
    },
    sample: ({ portalUrl }) => ({
      instructorEmail: 'lin.wei@example.com',
      reviewUrl: `${portalUrl}/admin/instructors/3f6c2a9e-8d41-4b7a-9c55-2e1f0b7d4a10`,
    }),
  },
  'documents.assigned': {
    build: (catalog, vars, language) =>
      documentList(catalog, catalog.email.documents.assigned, vars, language),
    sample: ({ portalUrl }) => ({
      displayName: SAMPLE_NAME,
      documents: SAMPLE_DOCUMENTS,
      onboardingUrl: `${portalUrl}/onboarding`,
    }),
  },
  'documents.reminder': {
    build: (catalog, vars, language) =>
      documentList(catalog, catalog.email.documents.reminder, vars, language),
    sample: ({ portalUrl }) => ({
      displayName: SAMPLE_NAME,
      documents: SAMPLE_DOCUMENTS,
      onboardingUrl: `${portalUrl}/onboarding`,
    }),
  },
  'documents.completed': {
    build: (catalog, vars, language) => {
      const copy = catalog.email.documents.completed;
      const url = vars.onboardingUrl?.trim();
      const blocks = fill(copy, {
        title: documentTitle(vars.document, language),
      });
      return {
        ...blocks,
        greeting: greet(catalog, vars.displayName),
        fingerprint: { label: copy.fingerprintLabel, value: vars.sha256 },
        ...(url ? { button: { label: copy.button, url } } : {}),
      };
    },
    sample: ({ portalUrl }) => ({
      displayName: SAMPLE_NAME,
      document: SAMPLE_DOCUMENTS[0],
      sha256: SAMPLE_SHA256,
      onboardingUrl: `${portalUrl}/onboarding`,
    }),
  },
};

/** Every template name, in registry order. */
export const EMAIL_TEMPLATE_NAMES = Object.keys(
  EMAIL_TEMPLATES,
) as EmailTemplate[];

export function isEmailTemplate(value: string): value is EmailTemplate {
  return Object.hasOwn(EMAIL_TEMPLATES, value);
}
