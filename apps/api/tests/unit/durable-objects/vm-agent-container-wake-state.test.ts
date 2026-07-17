import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import { createSqliteD1 } from '../../helpers/sqlite-d1';

const jwtMocks = vi.hoisted(() => ({
  signCallbackToken: vi.fn(async () => 'workspace-token'),
  signNodeCallbackToken: vi.fn(async () => 'node-token'),
  signNodeManagementToken: vi.fn(async () => ({ token: 'management-token' })),
}));

vi.mock('../../../src/services/jwt', () => jwtMocks);

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

  it('sanitizes an unexpected wake failure and records degraded recovery', async () => {
    const storage = {
      get: vi.fn(async (key: string) => {
        if (key === 'lifecycleStatus') return 'replacing';
        if (key === 'recoveryAttempts') return 0;
        if (key === 'launchConfig') return { workspaceId: 'ws-1' };
        return undefined;
      }),
      put: vi.fn(),
    };
    const markWakeDegraded = vi.fn();
    const fake = {
      wakeChain: Promise.resolve(),
      wakeFromSnapshot: vi.fn().mockRejectedValue(new Error('secret upstream response')),
      markWakeDegraded,
      getRecoveryMaxAttempts: () => 2,
      ctx: { storage },
    };
    const ensureAwake = (
      VmAgentContainer.prototype as unknown as {
        ensureAwake: (this: unknown) => Promise<{ ok: boolean; message?: string }>;
      }
    ).ensureAwake;

    const result = await ensureAwake.call(fake);

    expect(result).toEqual({
      ok: false,
      message: 'Runtime recovery failed safely; transcript and partial output remain available.',
    });
    expect(result.message).not.toContain('secret upstream response');
    expect(markWakeDegraded).toHaveBeenCalledWith(
      { workspaceId: 'ws-1' },
      'secret upstream response'
    );
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
  const onError = (
    VmAgentContainer.prototype as unknown as {
      onError: (this: unknown, error: unknown) => Promise<void>;
    }
  ).onError;

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

  it('classifies the Cloudflare rollout onError message as recoverable replacement', async () => {
    const { fake, markRuntimeReplacing, markRuntimeEnded } = makeStopFake('running');
    await onError.call(
      fake,
      new Error('Runtime signalled the container to exit due to a new version rollout: 0')
    );
    expect(markRuntimeReplacing).toHaveBeenCalledTimes(1);
    expect(markRuntimeEnded).not.toHaveBeenCalled();
  });

  it('keeps an ordinary container error terminal', async () => {
    const { fake, markRuntimeReplacing, markRuntimeEnded, put } = makeStopFake('running');
    await onError.call(fake, new Error('process crashed'));
    expect(markRuntimeReplacing).not.toHaveBeenCalled();
    expect(markRuntimeEnded).toHaveBeenCalledWith('error', 'Container error: process crashed');
    expect(put).toHaveBeenCalledWith('lifecycleStatus', 'error');
  });

  it('handles a repeated replacement stop idempotently', async () => {
    const { fake, markRuntimeReplacing, markRuntimeEnded } = makeStopFake('replacing');
    await onStop.call(fake, { exitCode: 0, reason: 'runtime_signal' });
    expect(markRuntimeReplacing).not.toHaveBeenCalled();
    expect(markRuntimeEnded).not.toHaveBeenCalled();
  });
});

describe('VmAgentContainer wakeFromSnapshot vertical slice', () => {
  function makeFixture(restoreResponse: Response) {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE nodes (id TEXT PRIMARY KEY, status TEXT, health_status TEXT, error_message TEXT, updated_at TEXT);
      CREATE TABLE workspaces (id TEXT PRIMARY KEY, user_id TEXT, chat_session_id TEXT, status TEXT, error_message TEXT, updated_at TEXT);
      CREATE TABLE agent_sessions (id TEXT PRIMARY KEY, workspace_id TEXT, agent_type TEXT, status TEXT, error_message TEXT, updated_at TEXT);
      INSERT INTO nodes VALUES ('node-1', 'recovery', 'unhealthy', NULL, '2026-01-01');
      INSERT INTO workspaces VALUES ('ws-1', 'user-1', 'chat-1', 'recovery', NULL, '2026-01-01');
      INSERT INTO agent_sessions VALUES ('agent-active', 'ws-1', 'codex', 'recovery', NULL, '2026-01-01');
      INSERT INTO agent_sessions VALUES ('agent-newer-decoy', 'ws-1', 'claude-code', 'running', NULL, '2026-01-02');
    `);
    const values = new Map<string, unknown>([
      [
        'launchConfig',
        {
          nodeId: 'node-1',
          workspaceId: 'ws-1',
          projectId: 'project-1',
          chatSessionId: 'chat-1',
          repository: 'owner/repo',
          branch: 'main',
          workspaceDir: '/workspace',
          controlPlaneUrl: 'https://control.invalid',
          vmAgentPort: 8080,
        },
      ],
      ['recoveryAgentSessionId', 'agent-active'],
      ['recoveryPromptDisposition', 'interrupted_manual_retry'],
      ['recoveryMode', true],
    ]);
    const storage = {
      get: vi.fn(async (key: string) => values.get(key)),
      put: vi.fn(async (key: string, value: unknown) => {
        values.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        values.delete(key);
        return true;
      }),
    };
    const containerFetch = vi.fn(async () => restoreResponse.clone());
    const fake = {
      env: { DATABASE: createSqliteD1(sqlite) },
      ctx: { storage },
      launch: vi.fn(),
      containerFetch,
      markWakeDegraded: (VmAgentContainer.prototype as unknown as { markWakeDegraded: unknown })
        .markWakeDegraded,
    };
    return { sqlite, values, containerFetch, fake };
  }

  const wake = (
    VmAgentContainer.prototype as unknown as {
      wakeFromSnapshot: (this: unknown) => Promise<{ ok: boolean; message?: string }>;
    }
  ).wakeFromSnapshot;

  it('restores the interrupted session and consumes manual-retry disposition exactly once', async () => {
    const fixture = makeFixture(
      new Response(JSON.stringify({ status: 'restored' }), { status: 200 })
    );
    expect(await wake.call(fixture.fake)).toEqual({ ok: true });
    expect(fixture.containerFetch.mock.calls[0]?.[0].url).toContain(
      '/agent-sessions/agent-active/restore'
    );
    const active = fixture.sqlite
      .prepare('SELECT error_message FROM agent_sessions WHERE id = ?')
      .get('agent-active') as { error_message: string };
    expect(active.error_message).toContain('retry it manually');
    expect(fixture.values.has('recoveryPromptDisposition')).toBe(false);
    expect(fixture.values.has('recoveryAgentSessionId')).toBe(false);
    expect(fixture.values.has('recoveryMode')).toBe(false);

    expect(await wake.call(fixture.fake)).toEqual({ ok: true });
    expect(fixture.containerFetch.mock.calls[1]?.[0].url).toContain(
      '/agent-sessions/agent-active/restore'
    );
    const decoy = fixture.sqlite
      .prepare('SELECT error_message FROM agent_sessions WHERE id = ?')
      .get('agent-newer-decoy') as { error_message: string | null };
    expect(decoy.error_message).toBeNull();
  });

  it('never exposes a raw failed restore body while persisting sanitized diagnostics', async () => {
    const sentinel = 'secret=/root/private-token';
    const fixture = makeFixture(new Response(sentinel, { status: 500 }));
    const result = await wake.call(fixture.fake);
    expect(result.ok).toBe(false);
    expect(result.message).not.toContain(sentinel);
    const workspace = fixture.sqlite
      .prepare('SELECT error_message FROM workspaces WHERE id = ?')
      .get('ws-1') as { error_message: string };
    expect(workspace.error_message).toBe(
      'Runtime recovery is degraded; transcript and partial output remain available.'
    );
    expect(workspace.error_message).not.toContain(sentinel);
  });
});
