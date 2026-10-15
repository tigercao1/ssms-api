import { legalNameOf } from './legal-name';

describe('legalNameOf', () => {
  it('joins the trimmed first and last name', () => {
    expect(
      legalNameOf({
        first_name: ' Jane ',
        last_name: ' Doe',
        display_name_en: 'JJ',
      }),
    ).toBe('Jane Doe');
  });

  it.each([
    ['no first name', null, 'Doe'],
    ['no last name', 'Jane', null],
    ['a blank last name', 'Jane', '  '],
    ['neither name', null, null],
  ])('falls back to the display name with %s', (_label, first, last) => {
    expect(
      legalNameOf({
        first_name: first,
        last_name: last,
        display_name_en: 'JJ',
      }),
    ).toBe('JJ');
  });
});
