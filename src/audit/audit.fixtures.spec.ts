import { Test } from '@nestjs/testing';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import { makeFakeSupabase } from '../../test/helpers/make-fake-supabase';
import { instructors } from '../../test/fixtures/seed';
import { AuditService } from './audit.service';
import { AUDIT_ACTIONS } from './audit.types';

/**
 * Exercises the shared `makeFakeSupabase()` double + the fixture seeder against
 * the audit writer, so both T10.1 test utilities are covered by a real spec
 * (not dead code) and demonstrate the intended usage pattern.
 */
describe('AuditService with shared fixtures + fake Supabase', () => {
  it('appends a row through the fake client and records the call', async () => {
    const fake = makeFakeSupabase({
      tables: { audit_log: { data: null, error: null } },
    });
    const moduleRef = await Test.createTestingModule({
      providers: [
        AuditService,
        { provide: SUPABASE_CLIENT, useValue: fake.client },
      ],
    }).compile();
    const service = moduleRef.get(AuditService);

    const target = instructors.approvedActive;
    await service.record({
      action: AUDIT_ACTIONS.instructorActivate,
      actor: { userId: 'admin-1', role: 'admin' },
      targetType: 'instructor',
      targetId: target.id,
      metadata: { from: false, to: true },
    });

    expect(fake.fromCalls).toContain('audit_log');
    expect(fake.inserts).toHaveLength(1);
    expect(fake.inserts[0].table).toBe('audit_log');
    expect(fake.inserts[0].row).toEqual(
      expect.objectContaining({
        action: 'instructor.activate',
        target_id: target.id,
        actor_role: 'admin',
      }),
    );
  });
});
