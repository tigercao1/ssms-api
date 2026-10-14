import { ServiceUnavailableException } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  SESSION_LIVENESS_TTL_MS,
  SessionLivenessService,
} from './session-liveness.service';

const SESSION = '0b8f7a62-3c4d-4e5f-8a9b-0c1d2e3f4a5b';

function setup(...results: Array<{ data: unknown; error: unknown } | Error>): {
  service: SessionLivenessService;
  rpc: jest.Mock;
  clock: { now: () => number; t: number };
} {
  const rpc = jest.fn();
  for (const result of results) {
    if (result instanceof Error) {
      rpc.mockRejectedValueOnce(result);
    } else {
      rpc.mockResolvedValueOnce(result);
    }
  }
  const clock = { t: 1_000_000, now: (): number => clock.t };
  const service = new SessionLivenessService(
    { rpc } as unknown as SupabaseClient,
    clock,
  );
  return { service, rpc, clock };
}

describe('SessionLivenessService', () => {
  it('calls session_is_active with the session id', async () => {
    const { service, rpc } = setup({ data: true, error: null });

    await expect(service.isActive(SESSION)).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledWith('session_is_active', {
      p_session_id: SESSION,
    });
  });

  it('caches an active session for 30 seconds, then re-checks', async () => {
    const { service, rpc, clock } = setup(
      { data: true, error: null },
      { data: false, error: null },
    );

    await expect(service.isActive(SESSION)).resolves.toBe(true);
    clock.t += SESSION_LIVENESS_TTL_MS - 1;
    await expect(service.isActive(SESSION)).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledTimes(1);

    clock.t += 1;
    await expect(service.isActive(SESSION)).resolves.toBe(false);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('never caches an inactive session', async () => {
    const { service, rpc } = setup(
      { data: false, error: null },
      { data: null, error: null },
      { data: true, error: null },
    );

    await expect(service.isActive(SESSION)).resolves.toBe(false);
    await expect(service.isActive(SESSION)).resolves.toBe(false);
    await expect(service.isActive(SESSION)).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledTimes(3);
  });

  it('caches per session id', async () => {
    const { service, rpc } = setup(
      { data: true, error: null },
      { data: false, error: null },
    );

    await expect(service.isActive(SESSION)).resolves.toBe(true);
    await expect(service.isActive('other-session')).resolves.toBe(false);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('throws 503 when the rpc returns an error', async () => {
    const { service } = setup({ data: null, error: { message: 'boom' } });

    await expect(service.isActive(SESSION)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('throws 503 when the rpc call rejects', async () => {
    const { service } = setup(new Error('network down'));

    await expect(service.isActive(SESSION)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('does not cache after an rpc error', async () => {
    const { service, rpc } = setup(
      { data: null, error: { message: 'boom' } },
      { data: true, error: null },
    );

    await expect(service.isActive(SESSION)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(service.isActive(SESSION)).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('bounds the cache, dropping expired entries first', async () => {
    const { service, rpc, clock } = setup();
    rpc.mockResolvedValue({ data: true, error: null });

    for (let i = 0; i < 10_000; i++) {
      await service.isActive(`stale-${i}`);
    }
    clock.t += SESSION_LIVENESS_TTL_MS;
    await service.isActive('fresh-a');
    await service.isActive('fresh-b');
    rpc.mockClear();

    await service.isActive('fresh-a');
    await service.isActive('fresh-b');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('clears the cache when it is full of live entries', async () => {
    const { service, rpc } = setup();
    rpc.mockResolvedValue({ data: true, error: null });

    for (let i = 0; i < 10_000; i++) {
      await service.isActive(`live-${i}`);
    }
    await service.isActive('overflow');
    rpc.mockClear();

    await service.isActive('live-0');
    await service.isActive('overflow');
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('session_is_active', {
      p_session_id: 'live-0',
    });
  });
});
