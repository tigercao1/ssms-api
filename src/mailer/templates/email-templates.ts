import { interpolate, type EmailCopy, type MessageCatalog } from '../../i18n';
import type { Vars } from '../../i18n';
import type { EmailTemplate, EmailTemplateVars } from '../mailer.types';

/** One language's worth of an email, as plain strings (escaped at layout time). */
export interface EmailBlocks {
  subject: string;
  preheader: string;
  heading: string;
  greeting: string | null;
  paragraphs: string[];
  code?: { label: string | null; value: string };
  button?: { label: string; url: string };
  finePrint: string;
}

/** Values the preview samples build links from. */
export interface SampleContext {
  portalUrl: string;
}

export interface TemplateDefinition<T extends EmailTemplate> {
  build(catalog: MessageCatalog, vars: EmailTemplateVars[T]): EmailBlocks;
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
      code: SAMPLE_CODE,
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
      code: SAMPLE_CODE,
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
      code: SAMPLE_CODE,
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
      code: SAMPLE_CODE,
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
};

/** Every template name, in registry order. */
export const EMAIL_TEMPLATE_NAMES = Object.keys(
  EMAIL_TEMPLATES,
) as EmailTemplate[];

export function isEmailTemplate(value: string): value is EmailTemplate {
  return Object.hasOwn(EMAIL_TEMPLATES, value);
}
