import { describe, expect, it, vi } from 'vitest';

import { VmAgentContainer } from '../../../src/durable-objects/vm-agent-container';

// Regression test for the restored-session prompt failure: `proxyHttp` read the
// container state ONCE before `wakeFromSnapshot()`, then applied the
// `stopped`/`stopped_with_code` -> 410 guard using that stale pre-wake state.
// A freshly-woken, restored container was therefore rejected with 410 (surfaced
// by the Worker as a generic 500), even though restore succeeded. The fix
// re-reads the container state after a successful wake.

interface FakeState {
  status: string;
}

function makeFake(opts: {
  statuses: string[]; // sequence returned by getState()
  lifecycleStatus: string;
  wakeOk: boolean;
}) {
  const getState = vi.fn<[], Promise<FakeState>>();
  for (const s of opts.statuses) {
    getState.mockResolvedValueOnce({ status: s });
  }
  getState.mockResolvedValue({ status: opts.statuses[opts.statuses.length - 1] });

  const containerFetch = vi.fn().mockResolvedValue(new Response('proxied', { status: 200 }));
  const wakeFromSnapshot = vi
    .fn()
    .mockResolvedValue(opts.wakeOk ? { ok: true } : { ok: false, message: 'degraded' });

  const fake = {
    getState,
    containerFetch,
    wakeFromSnapshot,
    defaultPort: 8080,
    wakeChain: Promise.resolve(),
    ensureAwake: (VmAgentContainer.prototype as unknown as { ensureAwake: unknown }).ensureAwake,
    ctx: { storage: { get: vi.fn().mockResolvedValue(opts.lifecycleStatus) } },
  };
  return { fake, getState, containerFetch, wakeFromSnapshot };
}

function callProxyHttp(fake: unknown, request: Request): Promise<Response> {
  return (
    VmAgentContainer.prototype as unknown as {
      proxyHttp: (this: unknown, request: Request, port?: number) => Promise<Response>;
    }
  ).proxyHttp.call(fake, request);
}

describe('VmAgentContainer.proxyHttp wake state re-read', () => {
  it('proxies the prompt after a successful wake even though the pre-wake state was stopped', async () => {
    // Pre-wake getState -> stopped; post-wake getState -> running (fresh container).
    const { fake, getState, containerFetch, wakeFromSnapshot } = makeFake({
      statuses: ['stopped', 'running'],
      lifecycleStatus: 'sleeping',
      wakeOk: true,
    });

    const res = await callProxyHttp(
      fake,
      new Request('http://container/prompt', { method: 'POST' })
    );

    expect(wakeFromSnapshot).toHaveBeenCalledTimes(1);
    // State must be re-read after wake (once before, once after) so the stopped
    // guard sees the now-running container.
    expect(getState).toHaveBeenCalledTimes(2);
    // The request is proxied to the running container, NOT rejected with 410.
    expect(containerFetch).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });

  it('returns 503 (not 410/proxy) when wake fails', async () => {
    const { fake, containerFetch } = makeFake({
      statuses: ['stopped', 'stopped'],
      lifecycleStatus: 'sleeping',
      wakeOk: false,
    });

    const res = await callProxyHttp(
      fake,
      new Request('http://container/prompt', { method: 'POST' })
    );

    expect(res.status).toBe(503);
    expect(containerFetch).not.toHaveBeenCalled();
  });

  it('still returns 410 for a genuinely stopped, non-sleeping container', async () => {
    const { fake, containerFetch, wakeFromSnapshot } = makeFake({
      statuses: ['stopped'],
      lifecycleStatus: 'running',
      wakeOk: true,
    });

    const res = await callProxyHttp(
      fake,
      new Request('http://container/prompt', { method: 'POST' })
    );

    expect(wakeFromSnapshot).not.toHaveBeenCalled();
    expect(containerFetch).not.toHaveBeenCalled();
    expect(res.status).toBe(410);
  });
});

describe('VmAgentContainer.ensureAwake concurrency (rule 45)', () => {
  it('wakes a sleeping container exactly once under two concurrent requests', async () => {
    // Shared, mutable container state so the mock models a real wake: the first
    // wake flips lifecycleStatus to running, and getState follows it.
    const shared = { lifecycle: 'sleeping' as string };

    const getState = vi.fn(async () => ({
      status: shared.lifecycle === 'running' ? 'running' : 'stopped',
    }));
    const containerFetch = vi.fn().mockResolvedValue(new Response('proxied', { status: 200 }));
    const wakeFromSnapshot = vi.fn(async () => {
      // Simulate the async launch+restore so the two requests interleave across
      // this await; the second must observe the running state and NOT re-wake.
      await new Promise((r) => setTimeout(r, 20));
      shared.lifecycle = 'running';
      return { ok: true };
    });

    const fake = {
      getState,
      containerFetch,
      wakeFromSnapshot,
      defaultPort: 8080,
      wakeChain: Promise.resolve(),
      ensureAwake: (VmAgentContainer.prototype as unknown as { ensureAwake: unknown }).ensureAwake,
      ctx: { storage: { get: vi.fn(async () => shared.lifecycle) } },
    };

    const [a, b] = await Promise.all([
      callProxyHttp(fake, new Request('http://container/prompt', { method: 'POST' })),
      callProxyHttp(fake, new Request('http://container/prompt', { method: 'POST' })),
    ]);

    // The one-time launch+restore fired exactly once despite two concurrent
    // requests; both requests were proxied to the now-running container.
    expect(wakeFromSnapshot).toHaveBeenCalledTimes(1);
    expect(containerFetch).toHaveBeenCalledTimes(2);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });
});

describe('VmAgentContainer replacement recovery', () => {
  it('serializes concurrent replacement recovery and records one attempt', async () => {
    const values = new Map<string, unknown>([
      ['lifecycleStatus', 'replacing'],
      ['recoveryAttempts', 0],
    ]);
    const storage = {
      get: vi.fn(async (key: string) => values.get(key)),
      put: vi.fn(async (key: string, value: unknown) => {
        values.set(key, value);
      }),
    };
    const wakeFromSnapshot = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      values.set('lifecycleStatus', 'running');
      return { ok: true };
    });
    const fake = {
      wakeChain: Promise.resolve(),
      wakeFromSnapshot,
      getRecoveryMaxAttempts: () => 3,
      ctx: { storage },
    };
    const ensureAwake = (
      VmAgentContainer.prototype as unknown as {
        ensureAwake: (this: unknown) => Promise<{ ok: boolean; message?: string }>;
      }
    ).ensureAwake;

    const [first, second] = await Promise.all([ensureAwake.call(fake), ensureAwake.call(fake)]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(wakeFromSnapshot).toHaveBeenCalledTimes(1);
    expect(values.get('recoveryAttempts')).toBe(1);
  });

  it('stops attempting restore when the configured bound is exhausted', async () => {
    const values = new Map<string, unknown>([
      ['lifecycleStatus', 'replacing'],
      ['recoveryAttempts', 2],
    ]);
    const storage = {
      get: vi.fn(async (key: string) => values.get(key)),
      put: vi.fn(async (key: string, value: unknown) => {
        values.set(key, value);
      }),
    };
    const wakeFromSnapshot = vi.fn();
    const fake = {
      wakeChain: Promise.resolve(),
      wakeFromSnapshot,
      getRecoveryMaxAttempts: () => 2,
      ctx: { storage },
    };
    const ensureAwake = (
      VmAgentContainer.prototype as unknown as {
        ensureAwake: (this: unknown) => Promise<{ ok: boolean; message?: string }>;
      }
    ).ensureAwake;

    const result = await ensureAwake.call(fake);

    expect(result.ok).toBe(false);
    expect(result.message).toContain('exhausted');
    expect(wakeFromSnapshot).not.toHaveBeenCalled();
    expect(values.get('lifecycleStatus')).toBe('error');
  });
});

describe('VmAgentContainer stop classification', () => {
  const onStop = (
    VmAgentContainer.prototype as unknown as {
      onStop: (
        this: unknown,
        params: { exitCode: number; reason: 'exit' | 'runtime_signal' }
      ) => Promise<void>;
    }
  ).onStop;

  function makeStopFake(status: string) {
    const put = vi.fn();
    const markRuntimeReplacing = vi.fn();
    const markRuntimeEnded = vi.fn();
    return {
      fake: {
        ctx: { storage: { get: vi.fn().mockResolvedValue(status), put } },
        markRuntimeReplacing,
        markRuntimeEnded,
      },
      put,
      markRuntimeReplacing,
      markRuntimeEnded,
    };
  }

  it('classifies runtime_signal as recoverable replacement', async () => {
    const { fake, markRuntimeReplacing, markRuntimeEnded } = makeStopFake('running');
    await onStop.call(fake, { exitCode: 0, reason: 'runtime_signal' });
    expect(markRuntimeReplacing).toHaveBeenCalledTimes(1);
    expect(markRuntimeEnded).not.toHaveBeenCalled();
  });

  it('keeps an intentional stop terminal', async () => {
    const { fake, markRuntimeReplacing, markRuntimeEnded, put } = makeStopFake('stopping');
    await onStop.call(fake, { exitCode: 0, reason: 'runtime_signal' });
    expect(markRuntimeReplacing).not.toHaveBeenCalled();
    expect(markRuntimeEnded).toHaveBeenCalledWith('stopped', 'Container stopped by user request');
    expect(put).toHaveBeenCalledWith('lifecycleStatus', 'stopped');
  });

  it('keeps an application exit terminal', async () => {
    const { fake, markRuntimeReplacing, markRuntimeEnded, put } = makeStopFake('running');
    await onStop.call(fake, { exitCode: 2, reason: 'exit' });
    expect(markRuntimeReplacing).not.toHaveBeenCalled();
    expect(markRuntimeEnded).toHaveBeenCalledWith('error', 'Container stopped: exit (2)');
    expect(put).toHaveBeenCalledWith('lifecycleStatus', 'error');
  });

  it('handles a repeated replacement stop idempotently', async () => {
    const { fake, markRuntimeReplacing, markRuntimeEnded } = makeStopFake('replacing');
    await onStop.call(fake, { exitCode: 0, reason: 'runtime_signal' });
    expect(markRuntimeReplacing).not.toHaveBeenCalled();
    expect(markRuntimeEnded).not.toHaveBeenCalled();
  });
});
