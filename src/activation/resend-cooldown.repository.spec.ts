import { DatabaseError } from '../database/db-result';
import { SupabaseResendCooldownRepository } from './resend-cooldown.repository';
import { FakeSupabase } from './supabase-fake.test-util';

const HASH = 'a'.repeat(64);

function setup() {
  const db = new FakeSupabase();
  return { db, repo: new SupabaseResendCooldownRepository(db.asClient()) };
}

describe('SupabaseResendCooldownRepository', () => {
  it('reports an accepted claim with the full wait', async () => {
    const { db, repo } = setup();
    db.rpcResult = {
      data: [{ accepted: true, retry_after_seconds: 60 }],
      error: null,
    };
    await expect(repo.claim(HASH)).resolves.toEqual({
      accepted: true,
      retryAfterSeconds: 60,
    });
  });

  it('reports a refused claim with the seconds left', async () => {
    const { db, repo } = setup();
    db.rpcResult = {
      data: [{ accepted: false, retry_after_seconds: 17 }],
      error: null,
    };
    await expect(repo.claim(HASH)).resolves.toEqual({
      accepted: false,
      retryAfterSeconds: 17,
    });
  });

  it('reads the seconds left, 0 when the database has none', async () => {
    const { db, repo } = setup();
    db.rpcResult = { data: 42, error: null };
    await expect(repo.retryAfterSeconds(HASH)).resolves.toBe(42);
    db.rpcResult = { data: null, error: null };
    await expect(repo.retryAfterSeconds(HASH)).resolves.toBe(0);
  });

  it.each([
    ['claim', (repo: SupabaseResendCooldownRepository) => repo.claim(HASH)],
    [
      'retryAfterSeconds',
      (repo: SupabaseResendCooldownRepository) => repo.retryAfterSeconds(HASH),
    ],
  ])('%s raises a database error', async (_name, call) => {
    const { db, repo } = setup();
    db.rpcResult = { data: null, error: { message: 'boom' } };
    await expect(call(repo)).rejects.toBeInstanceOf(DatabaseError);
  });

  it('raises when a claim returns no row', async () => {
    const { db, repo } = setup();
    db.rpcResult = { data: [], error: null };
    await expect(repo.claim(HASH)).rejects.toThrow('no row');
  });
});
