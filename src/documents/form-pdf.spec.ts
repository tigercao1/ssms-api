import { pdftotext } from '../../test/helpers/pdf-render';
import { signaturePng } from '../../test/helpers/png-fixtures';
import { SIGNING_CONSENT } from './document-signing.service';
import { renderFormPdf, type FormPdfInput } from './form-pdf';
import { defaultWaiverFields } from './form-templates.types';
import { loadStampFonts } from './pdf-stamper';
import { MAX_SIGNATURE_PNG_BYTES } from './signing-input';

jest.setTimeout(60_000);

const input = (overrides: Partial<FormPdfInput> = {}): FormPdfInput => ({
  title: 'Lesson waiver',
  bodyMarkdown: '## Risks\n\nSkiing is **dangerous**.\n\n* Wear a helmet',
  fields: defaultWaiverFields('en'),
  values: { participant_name: 'Mia Chen', email: 'mia@example.com' },
  signatures: {},
  answersHeading: 'Answers',
  audit: {
    titleEn: 'Lesson waiver',
    titleZh: null,
    templateSha256: 'a'.repeat(64),
    assignmentId: '00000000-0000-4000-8000-000000000001',
    signerName: 'Mia Chen',
    signerEmail: 'mia@example.com',
    consentEn: SIGNING_CONSENT.en,
    consentZh: SIGNING_CONSENT.zh,
    ip: '203.0.113.1',
    userAgent: 'Mobile Safari',
    viewedAt: null,
    signedAt: '2026-11-08T02:00:00.000Z',
  },
  ...overrides,
});

describe('renderFormPdf', () => {
  it('prints the waiver text without markdown markers, a dash for blank answers, and the audit page', async () => {
    const { bytes } = await renderFormPdf(input());
    const text = await pdftotext(bytes);

    expect(text).toContain('Skiing is dangerous.');
    expect(text).not.toContain('**');
    expect(text).toMatch(/•\s+Wear a helmet/);
    expect(text).toMatch(/Witness name\s+—/);
    expect(text).toContain('Signature record / 签署记录');
    expect(text).toContain('a'.repeat(64));
  });

  it('flows a long waiver over several pages and stays within the VM memory budget', async () => {
    const paragraph = `${'I understand the risks of alpine skiing. '.repeat(20)}\n\n`;
    const bodyMarkdown = paragraph.repeat(
      Math.floor(50_000 / paragraph.length),
    );
    let big = signaturePng(300, 170, { noise: true });
    expect(big.length).toBeLessThanOrEqual(MAX_SIGNATURE_PNG_BYTES);
    await loadStampFonts();
    global.gc?.();
    const before = process.memoryUsage().rss;
    let peak = before;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 5);

    const { bytes } = await renderFormPdf(
      input({
        bodyMarkdown,
        signatures: {
          participant_signature: big,
          guardian_signature: big,
          witness_signature: big,
        },
      }),
    );

    clearInterval(sampler);
    peak = Math.max(peak, process.memoryUsage().rss);
    big = Buffer.alloc(0);
    const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
    console.log(
      `form-pdf 50k-char waiver + 3 signatures: output ${mb(bytes.byteLength)} MB, ` +
        `RSS before ${mb(before)} MB, sampled peak ${mb(peak)} MB (+${mb(peak - before)} MB)`,
    );
    expect(bytes.byteLength).toBeLessThan(5 * 1024 * 1024);
    expect(peak - before).toBeLessThan(150 * 1024 * 1024);
  });
});
