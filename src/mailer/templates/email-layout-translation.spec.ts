import { ConfigService } from '@nestjs/config';
import { parse, serialize, type DefaultTreeAdapterMap } from 'parse5';
import { MailerConfig } from '../mailer.config';
import { EMAIL_LANGUAGES } from '../mailer.types';
import { CARD_BG } from './email-layout';
import { EmailRenderer } from './email-renderer';
import { EMAIL_TEMPLATE_NAMES } from './email-templates';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
type TextNode = DefaultTreeAdapterMap['textNode'];
type Document = DefaultTreeAdapterMap['document'];

const renderer = new EmailRenderer(
  new MailerConfig({
    get: (key: string) =>
      ({
        PORTAL_URL: 'https://portal.example.com',
        EMAIL_LOGO_URL: 'https://cdn.example.com/email-logo.png',
      })[key],
  } as unknown as ConfigService),
);

function isElement(node: Node): node is Element {
  return 'tagName' in node;
}

function isText(node: Node): node is TextNode {
  return node.nodeName === '#text';
}

function descendants(node: Node): Node[] {
  if (!('childNodes' in node)) {
    return [];
  }
  return node.childNodes.flatMap((child) => [child, ...descendants(child)]);
}

function parentOf(node: Node): Node | null {
  return 'parentNode' in node ? node.parentNode : null;
}

function closest(node: Node, tagName: string): Element | null {
  for (let current = parentOf(node); current; current = parentOf(current)) {
    if (isElement(current) && current.tagName === tagName) {
      return current;
    }
  }
  return null;
}

function isInside(node: Node, ancestor: Element): boolean {
  for (let current = parentOf(node); current; current = parentOf(current)) {
    if (current === ancestor) {
      return true;
    }
  }
  return false;
}

function bodyOf(document: Document): Element {
  const body = descendants(document).find(
    (node): node is Element => isElement(node) && node.tagName === 'body',
  );
  if (!body) {
    throw new Error('no <body>');
  }
  return body;
}

function cardCellOf(document: Document): Element {
  const cells = descendants(document).filter(
    (node): node is Element =>
      isElement(node) &&
      node.tagName === 'td' &&
      node.attrs.some(
        (attr) =>
          attr.name === 'style' &&
          attr.value.includes(`background-color:${CARD_BG}`),
      ),
  );
  expect(cells).toHaveLength(1);
  return cells[0];
}

function textNodes(root: Element): TextNode[] {
  return descendants(root).filter(
    (node): node is TextNode => isText(node) && node.value.trim() !== '',
  );
}

function translate(html: string): {
  translated: Document;
  cardTokens: string[];
  outsideTokens: string[];
} {
  const document = parse(html);
  const card = cardCellOf(document);
  const cardTokens: string[] = [];
  const outsideTokens: string[] = [];
  textNodes(bodyOf(document)).forEach((node, index) => {
    const token = `segment${index}`;
    node.value = `Translated ${token} ${'and some longer words '.repeat((index % 4) + 1)}`;
    (isInside(node, card) ? cardTokens : outsideTokens).push(token);
  });
  return { translated: parse(serialize(document)), cardTokens, outsideTokens };
}

function tokenIn(node: TextNode): string {
  const match = /segment\d+/.exec(node.value);
  if (!match) {
    throw new Error(`untranslated text node: ${node.value}`);
  }
  return match[0];
}

describe('email layout under translation', () => {
  describe.each([...EMAIL_TEMPLATE_NAMES])('%s', (template) => {
    it.each(EMAIL_LANGUAGES)(
      'keeps every %s card block inside the one card cell',
      (language) => {
        const { html } = renderer.renderSample(template, language);
        const { translated, cardTokens, outsideTokens } = translate(html);
        const card = cardCellOf(translated);

        const inCard = textNodes(card).map(tokenIn);
        expect(inCard).toEqual(cardTokens);
        expect(cardTokens.length).toBeGreaterThan(3);
        const outside = textNodes(bodyOf(translated))
          .filter((node) => !isInside(node, card))
          .map(tokenIn);
        expect(outside).toEqual(outsideTokens);

        const blocks = descendants(card).filter(
          (node): node is Element =>
            isElement(node) && ['h1', 'p', 'table'].includes(node.tagName),
        );
        expect(blocks.length).toBeGreaterThan(3);
        for (const block of blocks) {
          expect(closest(block, 'td')).toBe(card);
        }
      },
    );
  });
});
