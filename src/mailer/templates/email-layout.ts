import {
  interpolate,
  type EmailLayoutCopy,
  type SupportedLanguage,
} from '../../i18n';
import type { EmailBlocks } from './email-templates';

/** One language block of an email, with that language's layout strings. */
export interface EmailSection {
  language: SupportedLanguage;
  blocks: EmailBlocks;
  layout: EmailLayoutCopy;
}

export interface EmailLayoutOptions {
  logoUrl: string;
  replyTo: string;
  brandName: string;
}

export const BRAND_RED = '#d71e2b';
const PAGE_BG = '#f4f4f5';
const CARD_BG = '#ffffff';
const TEXT = '#1f2937';
const HEADING = '#111827';
const MUTED = '#6b7280';
const RULE = '#e5e7eb';
const FONT_STACK =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif";
const MONO_STACK = "'SFMono-Regular',Menlo,Consolas,'Courier New',monospace";
const TEXT_DIVIDER = '------------------------------';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Renders the shared branded layout: table-based, inline styles only, PNG logo
 * header, white card, red button, footer. Multiple sections (bilingual) are
 * separated by a divider. Returns both the HTML and the plain-text alternative.
 */
export function renderEmailLayout(
  sections: EmailSection[],
  options: EmailLayoutOptions,
): { html: string; text: string } {
  return {
    html: renderHtml(sections, options),
    text: renderText(sections, options),
  };
}

function renderHtml(
  sections: EmailSection[],
  options: EmailLayoutOptions,
): string {
  const title = sections.map((s) => s.blocks.subject).join(' / ');
  const preheader = sections.map((s) => s.blocks.preheader).join(' / ');
  const body = sections
    .map((section) => sectionHtml(section))
    .join(dividerHtml());
  const footerLines = sections
    .map(
      (s) =>
        `<p lang="${s.language}" style="margin:4px 0 0;">${linkifyEmail(
          escapeHtml(s.layout.footerQuestions),
          options.replyTo,
        )}</p>`,
    )
    .join('');

  return [
    '<!DOCTYPE html>',
    `<html lang="${sections[0].language}" xmlns="http://www.w3.org/1999/xhtml">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="x-apple-disable-message-reformatting">',
    '<meta name="color-scheme" content="light">',
    '<meta name="supported-color-schemes" content="light">',
    `<title>${escapeHtml(title)}</title>`,
    '</head>',
    `<body style="margin:0;padding:0;width:100%;background-color:${PAGE_BG};">`,
    `<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${PAGE_BG};">${escapeHtml(preheader)}${'&#847;&zwnj;&nbsp;'.repeat(40)}</div>`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${PAGE_BG};">`,
    '<tr>',
    '<td align="center" style="padding:24px 12px;">',
    '<!--[if mso]><table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td><![endif]-->',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;">',
    '<tr>',
    '<td align="center" style="padding:8px 0 24px;">',
    `<img src="${escapeHtml(options.logoUrl)}" width="200" alt="${escapeHtml(options.brandName)}" style="display:block;width:200px;max-width:200px;height:auto;border:0;outline:none;text-decoration:none;">`,
    '</td>',
    '</tr>',
    '<tr>',
    `<td style="background-color:${CARD_BG};border:1px solid ${RULE};border-radius:8px;padding:32px 28px;font-family:${FONT_STACK};font-size:16px;line-height:26px;color:${TEXT};">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${body}</table>`,
    '</td>',
    '</tr>',
    '<tr>',
    `<td align="center" style="padding:24px 12px 8px;font-family:${FONT_STACK};font-size:13px;line-height:20px;color:${MUTED};">`,
    `<p style="margin:0;font-weight:bold;">${escapeHtml(options.brandName)}</p>`,
    footerLines,
    '</td>',
    '</tr>',
    '</table>',
    '<!--[if mso]></td></tr></table><![endif]-->',
    '</td>',
    '</tr>',
    '</table>',
    '</body>',
    '</html>',
  ].join('\n');
}

function sectionHtml({ language, blocks, layout }: EmailSection): string {
  const parts: string[] = [
    `<h1 style="margin:0 0 16px;font-family:${FONT_STACK};font-size:22px;line-height:30px;font-weight:bold;color:${HEADING};">${escapeHtml(blocks.heading)}</h1>`,
  ];
  if (blocks.greeting) {
    parts.push(paragraphHtml(blocks.greeting));
  }
  for (const paragraph of blocks.paragraphs) {
    parts.push(paragraphHtml(paragraph));
  }
  if (blocks.button) {
    parts.push(buttonHtml(blocks.button.label, blocks.button.url));
    parts.push(
      `<p style="margin:0 0 16px;font-size:13px;line-height:20px;color:${MUTED};">${escapeHtml(layout.buttonFallback)}<br><a href="${escapeHtml(blocks.button.url)}" style="color:${BRAND_RED};text-decoration:underline;word-break:break-all;">${escapeHtml(blocks.button.url)}</a></p>`,
    );
  }
  if (blocks.code) {
    if (blocks.code.label) {
      parts.push(paragraphHtml(blocks.code.label));
    }
    parts.push(codeHtml(blocks.code.value));
  }
  parts.push(
    `<p style="margin:24px 0 0;">${escapeHtml(layout.signoffLead)}<br>${escapeHtml(layout.signoffTeam)}</p>`,
  );
  if (blocks.finePrint) {
    parts.push(
      `<p style="margin:24px 0 0;font-size:13px;line-height:20px;color:${MUTED};">${escapeHtml(blocks.finePrint)}</p>`,
    );
  }
  return `<tr><td lang="${language}" style="font-family:${FONT_STACK};font-size:16px;line-height:26px;color:${TEXT};">${parts.join('')}</td></tr>`;
}

function paragraphHtml(text: string): string {
  return `<p style="margin:0 0 16px;">${escapeHtml(text)}</p>`;
}

function buttonHtml(label: string, url: string): string {
  const href = escapeHtml(url);
  return [
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;">',
    '<tr>',
    `<td align="center" bgcolor="${BRAND_RED}" style="background-color:${BRAND_RED};border-radius:6px;">`,
    `<a href="${href}" target="_blank" style="display:inline-block;padding:13px 28px;font-family:${FONT_STACK};font-size:16px;line-height:20px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:6px;">${escapeHtml(label)}</a>`,
    '</td>',
    '</tr>',
    '</table>',
  ].join('');
}

function codeHtml(code: string): string {
  return [
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;">',
    '<tr>',
    `<td style="background-color:${PAGE_BG};border:1px solid ${RULE};border-radius:6px;padding:12px 20px;font-family:${MONO_STACK};font-size:26px;line-height:32px;letter-spacing:6px;font-weight:bold;color:${HEADING};">${escapeHtml(code)}</td>`,
    '</tr>',
    '</table>',
  ].join('');
}

function dividerHtml(): string {
  return `<tr><td style="padding:32px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:1px solid ${RULE};font-size:1px;line-height:1px;">&nbsp;</td></tr></table></td></tr>`;
}

function linkifyEmail(escapedText: string, email: string): string {
  const escapedEmail = escapeHtml(email);
  return escapedText
    .split(escapedEmail)
    .join(
      `<a href="mailto:${escapedEmail}" style="color:${MUTED};text-decoration:underline;">${escapedEmail}</a>`,
    );
}

function renderText(
  sections: EmailSection[],
  options: EmailLayoutOptions,
): string {
  const body = sections
    .map((section) => sectionText(section))
    .join(`\n\n${TEXT_DIVIDER}\n\n`);
  const footer = [
    '--',
    options.brandName,
    ...sections.map((s) => s.layout.footerQuestions),
  ].join('\n');
  return `${body}\n\n${footer}\n`;
}

function sectionText({ blocks, layout }: EmailSection): string {
  const parts: string[] = [blocks.heading];
  if (blocks.greeting) {
    parts.push(blocks.greeting);
  }
  parts.push(...blocks.paragraphs);
  if (blocks.button) {
    parts.push(
      interpolate(layout.buttonLine, {
        label: blocks.button.label,
        url: blocks.button.url,
      }),
    );
  }
  if (blocks.code) {
    parts.push(
      blocks.code.label
        ? `${blocks.code.label}\n${blocks.code.value}`
        : blocks.code.value,
    );
  }
  parts.push(`${layout.signoffLead}\n${layout.signoffTeam}`);
  if (blocks.finePrint) {
    parts.push(blocks.finePrint);
  }
  return parts.join('\n\n');
}
