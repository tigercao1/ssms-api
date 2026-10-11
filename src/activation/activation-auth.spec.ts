import { InternalServerErrorException } from '@nestjs/common';
import { SupabaseActivationAuth } from './activation-auth';
import { FakeSupabase } from './supabase-fake.test-util';

describe('SupabaseActivationAuth', () => {
  function setup() {
    const db = new FakeSupabase();
    return { db, auth: new SupabaseActivationAuth(db.asClient()) };
  }

  it('reads the current email of a user', async () => {
    const { db, auth } = setup();
    db.auth.admin.getUserById.mockResolvedValueOnce({
      data: { user: { email: 'jane@example.test' } },
      error: null,
    });
    db.auth.admin.getUserById.mockResolvedValueOnce({
      data: { user: {} },
      error: null,
    });
    db.auth.admin.getUserById.mockResolvedValueOnce({
      data: { user: null },
      error: { status: 404, message: 'User not found' },
    });
    db.auth.admin.getUserById.mockResolvedValueOnce({
      data: { user: null },
      error: { status: 500, message: 'boom' },
    });
    expect(await auth.findEmail('a')).toBe('jane@example.test');
    expect(await auth.findEmail('a')).toBeNull();
    expect(await auth.findEmail('a')).toBeNull();
    await expect(auth.findEmail('a')).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });

  it('returns the hashed_token of a generated magic link', async () => {
    const { db, auth } = setup();
    db.auth.admin.generateLink.mockResolvedValue({
      data: { properties: { hashed_token: 'hashed' }, user: {} },
      error: null,
    });
    expect(await auth.magicLinkTokenHash('jane@example.test')).toBe('hashed');
    expect(db.auth.admin.generateLink).toHaveBeenCalledWith({
      type: 'magiclink',
      email: 'jane@example.test',
    });
  });

  it('fails when no token comes back', async () => {
    const { db, auth } = setup();
    db.auth.admin.generateLink.mockResolvedValueOnce({
      data: { properties: null, user: null },
      error: { message: 'rate limited' },
    });
    db.auth.admin.generateLink.mockResolvedValueOnce({
      data: null,
      error: null,
    });
    await expect(auth.magicLinkTokenHash('x')).rejects.toThrow('rate limited');
    await expect(auth.magicLinkTokenHash('x')).rejects.toThrow(
      'no token returned',
    );
  });
});
