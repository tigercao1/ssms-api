import { baseHandle, handleCandidate } from './instructor-handle';

const ID = '3f1c2b7a-9d4e-4c1a-8b2f-6a7e5d4c3b2a';

describe('instructor handles', () => {
  it.each([
    ['Eddie', 'eddie'],
    ['  Eddie  Chen ', 'eddie-chen'],
    ['Zoë O’Brien', 'zoe-o-brien'],
    ['小李 Vincent', 'vincent'],
    ['A'.repeat(70), 'a'.repeat(60)],
  ])('slugifies %j to %j', (name, expected) => {
    expect(baseHandle(ID, name)).toBe(expected);
  });

  it('falls back to the uuid prefix when the English name has no usable characters', () => {
    expect(baseHandle(ID, '小李')).toBe('instructor-3f1c2b7a');
    expect(baseHandle(ID, '')).toBe('instructor-3f1c2b7a');
  });

  it('numbers collisions from -2 upwards', () => {
    expect(handleCandidate('eddie', 1)).toBe('eddie');
    expect(handleCandidate('eddie', 2)).toBe('eddie-2');
    expect(handleCandidate('eddie', 3)).toBe('eddie-3');
  });
});
