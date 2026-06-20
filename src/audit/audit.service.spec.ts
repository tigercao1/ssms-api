import { Test } from '@nestjs/testing';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import { AuditService } from './audit.service';
import { AUDIT_ACTIONS } from './audit.types';

/** Minimal fake of `supabase.from(table).insert(row)` capturing the call. */
function makeFakeSupabase(insertResult: { error: { message: string } | null }) {
  const insert = jest.fn().mockResolvedValue(insertResult);
  const from = jest.fn().mockReturnValue({ insert });
  return { client: { from }, from, insert };
}

describe('AuditService', () => {
  async function build(insertResult: { error: { message: string } | null }) {
    const fake = makeFakeSupabase(insertResult);
    const moduleRef = await Test.createTestingModule({
      providers: [
        AuditService,
        { provide: SUPABASE_CLIENT, useValue: fake.client },
      ],
    }).compile();
    return { service: moduleRef.get(AuditService), fake };
  }

  it('writes exactly one row to audit_log, mapping camelCase → columns', async () => {
    const { service, fake } = await build({ error: null });

    await service.record({
      action: AUDIT_ACTIONS.instructorApprove,
      actor: {
        userId: 'admin-1',
        role: 'admin',
        userAgent: 'jest',
        ip: '1.2.3.4',
      },
      targetType: 'instructor',
      targetId: 'inst-9',
      metadata: { from: 'pending', to: 'approved' },
    });

    expect(fake.from).toHaveBeenCalledWith('audit_log');
    expect(fake.insert).toHaveBeenCalledTimes(1);
    expect(fake.insert).toHaveBeenCalledWith({
      actor_user_id: 'admin-1',
      actor_role: 'admin',
      action: 'instructor.approve',
      target_type: 'instructor',
      target_id: 'inst-9',
      metadata: { from: 'pending', to: 'approved' },
      ip: '1.2.3.4',
      user_agent: 'jest',
    });
  });

  it('defaults every optional field to null when omitted', async () => {
    const { service, fake } = await build({ error: null });

    await service.record({ action: AUDIT_ACTIONS.systemBootstrapAdmin });

    expect(fake.insert).toHaveBeenCalledWith({
      actor_user_id: null,
      actor_role: null,
      action: 'system.bootstrap_admin',
      target_type: null,
      target_id: null,
      metadata: null,
      ip: null,
      user_agent: null,
    });
  });

  it('never throws when the insert returns an error (best-effort)', async () => {
    const { service } = await build({ error: { message: 'audit down' } });
    await expect(
      service.record({ action: AUDIT_ACTIONS.notificationFailure }),
    ).resolves.toBeUndefined();
  });

  it('never throws when the client itself blows up', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        AuditService,
        {
          provide: SUPABASE_CLIENT,
          useValue: {
            from: () => {
              throw new Error('boom');
            },
          },
        },
      ],
    }).compile();
    const service = moduleRef.get(AuditService);
    await expect(
      service.record({ action: AUDIT_ACTIONS.apiKeyRevoke }),
    ).resolves.toBeUndefined();
  });
});
