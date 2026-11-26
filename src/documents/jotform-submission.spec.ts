import {
  type JotformSubmission,
  jotformSubmittedAt,
  mapJotformSubmission,
  toCsv,
} from './jotform-submission';

function zh(answers: JotformSubmission['answers']): JotformSubmission {
  return {
    id: '6693587400114977419',
    form_id: '242658653833264',
    ip: '209.171.1.2',
    created_at: '2026-11-01 11:12:20',
    answers,
  };
}

describe('mapJotformSubmission', () => {
  it('maps the Chinese form by question id', () => {
    expect(
      mapJotformSubmission(
        zh({
          '8': {
            answer: { datetime: '2026-11-01' },
            prettyFormat: '11/01/2026',
          },
          '9': { answer: null },
          '12': { answer: ' Mia Chen ' },
          '13': { answer: 'Li Chen' },
          '16': { answer: ' Mia.Chen@Example.com' },
          '20': { answer: 'Wit Ness' },
        }),
      ),
    ).toEqual({
      ok: true,
      fields: {
        submissionId: '6693587400114977419',
        formId: '242658653833264',
        submittedAt: '2026-11-01T16:12:20.000Z',
        email: 'mia.chen@example.com',
        participantName: 'Mia Chen',
        ip: '209.171.1.2',
        typedDate: '11/01/2026',
        guardianName: 'Li Chen',
        witnessName: 'Wit Ness',
      },
    });
  });

  it('reads the English form’s witness from its own question', () => {
    const mapped = mapJotformSubmission({
      id: '6638415864517873408',
      form_id: '232628492941059',
      created_at: '2026-08-29 15:39:46',
      answers: {
        '12': { answer: 'Xu Zhang' },
        '16': { answer: 'xu@example.com' },
        '17': { answer: 'Wit Ness' },
        '20': { answer: 'not a question on this form' },
      },
    });

    expect(mapped).toEqual({
      ok: true,
      fields: expect.objectContaining({
        submittedAt: '2026-08-29T19:39:46.000Z',
        witnessName: 'Wit Ness',
      }) as unknown,
    });
    expect(mapped.ok && mapped.fields.ip).toBeFalsy();
  });

  it.each([
    ['a missing email', { '12': { answer: 'Mia Chen' } }, 'no usable email'],
    [
      'an email that is not one',
      { '12': { answer: 'Mia Chen' }, '16': { answer: 'mia at example' } },
      'no usable email',
    ],
    [
      'a missing participant name',
      { '16': { answer: 'mia@example.com' } },
      'no participant name',
    ],
  ])('sends %s to review', (_label, answers, reason) => {
    expect(mapJotformSubmission(zh(answers))).toEqual({ ok: false, reason });
  });

  it('sends an unknown form or an unreadable submit time to review', () => {
    expect(mapJotformSubmission({ ...zh({}), form_id: '1' })).toEqual({
      ok: false,
      reason: 'unknown form 1',
    });
    expect(
      mapJotformSubmission({ ...zh({}), created_at: '11/01/2026' }),
    ).toEqual({ ok: false, reason: 'unreadable submit time 11/01/2026' });
  });
});

describe('jotformSubmittedAt', () => {
  it('reads Toronto wall-clock time on both sides of the DST change', () => {
    expect(jotformSubmittedAt('2026-10-31 23:59:59')).toBe(
      '2026-11-01T03:59:59.000Z',
    );
    expect(jotformSubmittedAt('2026-11-18 21:32:42')).toBe(
      '2026-11-19T02:32:42.000Z',
    );
  });
});

describe('toCsv', () => {
  it('quotes cells that need it', () => {
    expect(toCsv(['a', 'b'], [{ a: 'x,y', b: 'say "hi"' }, { a: null }])).toBe(
      'a,b\n"x,y","say ""hi"""\n,\n',
    );
  });
});
