import { matchLegalName } from './legal-name-match';

const jiayi = { firstName: 'Jiayi', lastName: 'Liu' };

describe('matchLegalName', () => {
  it.each([
    ['Jiayi Liu', 'same name'],
    ['JIAYI LIU', 'upper case'],
    ['jiayi liu', 'lower case'],
    ['Liu Jiayi', 'family name first'],
    ['LIU, Jiayi', 'Last, First'],
    ['Jia Yi Liu', 'given name split in two'],
    ['  Jiayi   Liu ', 'extra spaces'],
  ])('passes %s (%s)', (card) => {
    expect(matchLegalName(card, jiayi)).toMatchObject({
      status: 'pass',
      rule: 'exact',
    });
  });

  it('ignores accents, hyphens and apostrophes', () => {
    expect(
      matchLegalName('Zoe Tremblay', { firstName: 'Zoë', lastName: 'Tremblay' })
        .status,
    ).toBe('pass');
    expect(
      matchLegalName('Marie Claire Roy', {
        firstName: 'Marie-Claire',
        lastName: 'Roy',
      }).status,
    ).toBe('pass');
    expect(
      matchLegalName('Sean OBrien', { firstName: 'Seán', lastName: "O'Brien" })
        .status,
    ).toBe('pass');
  });

  it('passes a middle name on the card that the profile leaves out', () => {
    expect(
      matchLegalName('Mei Lin Chen', { firstName: 'Mei', lastName: 'Chen' }),
    ).toMatchObject({ status: 'pass', rule: 'middle_name' });
  });

  it('passes a card that leaves out a middle name the profile has', () => {
    expect(
      matchLegalName('Mei Chen', { firstName: 'Mei Lin', lastName: 'Chen' }),
    ).toMatchObject({ status: 'pass', rule: 'middle_name' });
  });

  it('sends a first initial to review', () => {
    expect(matchLegalName('J. Liu', jiayi)).toMatchObject({
      status: 'unsure',
      rule: 'initial',
    });
  });

  it('sends a one- or two-letter spelling difference to review', () => {
    expect(matchLegalName('Jiayl Liu', jiayi)).toMatchObject({
      status: 'unsure',
      rule: 'close_spelling',
    });
    expect(matchLegalName('Jaiyi Liu', jiayi)).toMatchObject({
      status: 'unsure',
      rule: 'close_spelling',
    });
  });

  it('sends an English first name with the same last name to review', () => {
    expect(matchLegalName('Kevin Liu', jiayi)).toMatchObject({
      status: 'unsure',
      rule: 'different_first_name',
    });
  });

  it('fails a different person', () => {
    expect(matchLegalName('Yachen Yuan', jiayi)).toMatchObject({
      status: 'fail',
      rule: 'different_person',
    });
    expect(matchLegalName('Jiayi Wang', jiayi)).toMatchObject({
      status: 'fail',
      rule: 'different_person',
    });
  });

  it('sends a name in Chinese characters to review', () => {
    expect(matchLegalName('刘佳怡', jiayi)).toMatchObject({
      status: 'unsure',
      rule: 'non_latin',
    });
  });

  it('sends the card to review when the profile has no legal name', () => {
    expect(
      matchLegalName('Jiayi Liu', { firstName: null, lastName: 'Liu' }),
    ).toMatchObject({ status: 'unsure', rule: 'no_legal_name' });
  });
});
