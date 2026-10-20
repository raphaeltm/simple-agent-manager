import type { Page } from '@playwright/test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Json, Turn } from '../playwright/staging-sam-dispatch-evidence';
import { confirmAwakeDispatchStop } from '../playwright/staging-sam-dispatch-stop';

function fixture() {
  const now = Date.now();
  const ledger: Json = {
    taskId: 'task',
    sessionId: 'session',
    workspaceId: 'workspace',
    nodeId: 'node',
    receipts: [{ id: 'stop', operation: 'sam_work_stop', state: 'completed' }],
  };
  const workspace = { nodeId: 'node', status: 'running' };
  const node = {
    status: 'running',
    heartbeatStaleAfterSeconds: 120,
    lastHeartbeatAt: new Date(now).toISOString(),
  };
  const agent = {
    chatSessionId: 'session',
    workspaceId: 'workspace',
    nodeId: 'node',
    agentType: 'openai-codex',
    status: 'running',
    lastHeartbeatAt: now,
  };
  const action = {
    id: 'stop',
    operation: 'sam_work_stop',
    state: 'completed',
    input_json: '{}',
    result_json: '{"status":"stopped","workspaceDeleted":true}',
  };
  const rows: Turn[] = [
    {
      id: 'turn',
      request_key: 'key',
      state: 'completed',
      message: '',
      response: 'Confirm stop',
      actions: [action],
    } as Turn,
  ];
  const click = vi.fn(async () => {});
  const filter = vi.fn(() => ({ getByRole: vi.fn(() => ({ click })) }));
  const response = {
    url: () => 'https://api.test/sam/actions/stop/confirm',
    request: () => ({ method: () => 'POST' }),
    ok: () => true,
    status: () => 200,
  };
  const page = {
    waitForResponse: vi.fn(async (predicate: (value: typeof response) => boolean) => {
      expect(predicate(response)).toBe(true);
      return response;
    }),
    locator: vi.fn(() => ({ filter })),
  };
  const get = vi.fn(async (url: string) => {
    if (url.endsWith('/workspaces/workspace')) return workspace;
    if (url.endsWith('/nodes/node')) return node;
    if (url.includes('/acp-sessions?')) return { sessions: [agent] };
    if (url.endsWith('/sam/turns')) return { turns: rows };
    if (url.endsWith('/tasks/task')) return { status: 'cancelled' };
    if (url.includes('/sessions/session?')) return { session: { status: 'stopped' } };
    if (url.endsWith('/workspaces')) return [];
    throw new Error('Unexpected test read');
  });
  return {
    page: page as unknown as Page,
    actionId: 'stop',
    stopMessage: 'Stop only this test session',
    ledger,
    deadline: now + 90_000,
    startedAt: now - 1_000,
    requestMs: 15_000,
    samApi: 'https://api.test/sam',
    projectApi: 'https://api.test/projects/project',
    stagingApi: 'https://api.test',
    check: (condition: boolean, label: string) => {
      if (!condition) throw new Error(label);
    },
    get: get as (url: string) => Promise<Json>,
    post: vi.fn(async () => ({ action })),
    save: vi.fn(async () => {}),
    response,
    record: vi.fn(async (turns: Turn[]) => turns),
    workspace,
    node,
    agent,
    click,
    action,
    filter,
  };
}

afterEach(() => vi.useRealTimers());

describe('awake stop confirmation and repeated effect evidence', () => {
  it('checks exact awake runtime, confirms once, replays same receipt and verifies teardown', async () => {
    const input = fixture();
    await confirmAwakeDispatchStop(input);
    expect(input.click).toHaveBeenCalledOnce();
    expect(input.filter).toHaveBeenCalledWith({ hasText: input.stopMessage });
    expect(input.post).toHaveBeenCalledExactlyOnceWith(
      'https://api.test/sam/actions/stop/confirm',
      { approved: true }
    );
    expect(input.ledger.stopConfirmation).toEqual({
      actionId: 'stop',
      repeatedSameReceipt: true,
      teardownVerified: true,
    });
  });
  it('accepts the observed 18.097s stop ACK beyond ordinary 15s reads', async () => {
    vi.useFakeTimers();
    const input = fixture();
    vi.mocked(input.page.waitForResponse).mockImplementation((_predicate, options) => {
      expect(options?.timeout).toBe(60_000);
      return new Promise((resolve) => setTimeout(() => resolve(input.response as never), 18_097));
    });
    const pending = confirmAwakeDispatchStop(input);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(input.post).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3_097);
    await pending;
    expect(input.ledger.stopConfirmationAttempt).toMatchObject({
      elapsedMs: 18_097,
      timeoutMs: 60_000,
      status: 200,
      category: 'http-response',
    });
    expect(input.click).toHaveBeenCalledExactlyOnceWith({ timeout: 15_000 });
    expect(input.post).toHaveBeenCalledOnce(); // Only the completed-receipt idempotency check.
    expect(input.ledger.stopConfirmation.teardownVerified).toBe(true);
  });
  it('caps the ACK by remaining work time while retaining verification reserve', async () => {
    vi.useFakeTimers();
    const input = fixture();
    input.deadline = Date.now() + 70_000;
    vi.mocked(input.page.waitForResponse).mockImplementation(async (_predicate, options) => {
      expect(options?.timeout).toBe(40_000);
      vi.setSystemTime(Date.now() + 40_000);
      const error = new Error('timeout');
      error.name = 'TimeoutError';
      throw error;
    });
    await expect(confirmAwakeDispatchStop(input)).rejects.toThrow(
      'Scoped stop confirmation accepted'
    );
    expect(input.ledger.stopConfirmationAttempt).toMatchObject({
      timeoutMs: 40_000,
      elapsedMs: 40_000,
      category: 'timeout',
      readback: { category: 'observed', state: 'completed' },
    });
    expect(input.click).toHaveBeenCalledOnce();
    expect(input.post).not.toHaveBeenCalled();
  });
  it('rechecks the work deadline after saving intent and never clicks when it expired', async () => {
    vi.useFakeTimers();
    const input = fixture();
    input.save.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 75_000);
    });
    await expect(confirmAwakeDispatchStop(input)).rejects.toThrow('work deadline');
    expect(input.page.waitForResponse).not.toHaveBeenCalled();
    expect(input.click).not.toHaveBeenCalled();
    expect(input.post).not.toHaveBeenCalled();
  });
  it('does not begin repeated confirmation when the completed-receipt read exhausts work time', async () => {
    vi.useFakeTimers();
    const input = fixture();
    const original = input.get;
    input.get = async (url) => {
      const result = await original(url);
      if (url.endsWith('/sam/turns')) vi.setSystemTime(input.deadline - 10_000);
      return result;
    };
    await expect(confirmAwakeDispatchStop(input)).rejects.toThrow('work deadline');
    expect(input.click).toHaveBeenCalledOnce();
    expect(input.post).not.toHaveBeenCalled();
    expect(input.ledger.stopConfirmation).toBeUndefined();
  });
  it.each([
    { name: 'timeout', status: null, category: 'timeout' },
    { name: 'HTTP rejection', status: 403, category: 'http-response' },
    { name: 'server rejection', status: 500, category: 'http-response' },
    { name: 'wait failure', status: null, category: 'wait-error' },
  ])(
    'preserves $name and observes the exact receipt once without repeating confirmation',
    async ({ name, status, category }) => {
      vi.useFakeTimers();
      const input = fixture();
      input.action.state = 'uncertain';
      input.action.result_json = '{"message":"PRIVATE_RESULT_MUST_NOT_LEAK"}';
      const snapshots: Json[] = [];
      input.save.mockImplementation(async () => {
        snapshots.push(structuredClone(input.ledger));
      });
      vi.mocked(input.page.waitForResponse).mockImplementation(async (_predicate, options) => {
        expect(options?.timeout).toBe(60_000);
        vi.setSystemTime(Date.now() + (status === null ? 60_000 : 400));
        if (status === null) {
          const error = new Error('PRIVATE_TRANSPORT_MUST_NOT_LEAK');
          error.name = name === 'timeout' ? 'TimeoutError' : 'Error';
          throw error;
        }
        return { ...input.response, status: () => status, ok: () => false } as never;
      });
      await expect(confirmAwakeDispatchStop(input)).rejects.toThrow(
        'Scoped stop confirmation accepted'
      );
      expect(input.ledger.stopConfirmationAttempt).toMatchObject({
        actionId: 'stop',
        status,
        category,
        elapsedMs: status === null ? 60_000 : 400,
        readback: { category: 'observed', state: 'uncertain' },
      });
      expect(snapshots.at(-1)?.stopConfirmationAttempt).toEqual(
        input.ledger.stopConfirmationAttempt
      );
      expect(JSON.stringify(snapshots)).not.toMatch(/PRIVATE_/);
      expect(input.click).toHaveBeenCalledOnce();
      expect(input.post).not.toHaveBeenCalled();
      expect(input.record).not.toHaveBeenCalled();
      expect(
        vi.mocked(input.get).mock.calls.filter(([url]) => url.endsWith('/sam/turns'))
      ).toHaveLength(1);
      expect(input.ledger.stopConfirmation).toBeUndefined();
    }
  );
  it('does not turn a later completed receipt into a successful rejected confirmation', async () => {
    const input = fixture();
    vi.mocked(input.page.waitForResponse).mockResolvedValue({
      ...input.response,
      status: () => 503,
      ok: () => false,
    } as never);
    await expect(confirmAwakeDispatchStop(input)).rejects.toThrow(
      'Scoped stop confirmation accepted'
    );
    expect(input.ledger.stopConfirmationAttempt.readback).toEqual({
      category: 'observed',
      state: 'completed',
    });
    expect(input.ledger.stopConfirmation).toBeUndefined();
    expect(input.post).not.toHaveBeenCalled();
  });
  it.each(['read-failure', 'different-action', 'unknown-state', 'save-failure'])(
    'preserves the original confirmation failure through %s',
    async (kind) => {
      const input = fixture();
      vi.mocked(input.page.waitForResponse).mockResolvedValue({
        ...input.response,
        status: () => 403,
        ok: () => false,
      } as never);
      const original = input.get;
      if (kind === 'read-failure')
        input.get = async (url) => {
          if (url.endsWith('/sam/turns')) throw new Error('PRIVATE_READ_MUST_NOT_LEAK');
          return original(url);
        };
      if (kind === 'different-action') input.action.id = 'other';
      if (kind === 'unknown-state') input.action.state = 'PRIVATE_STATE_MUST_NOT_LEAK';
      if (kind === 'save-failure')
        input.save
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error('PRIVATE_DISK_MUST_NOT_LEAK'));
      await expect(confirmAwakeDispatchStop(input)).rejects.toThrow(
        'Scoped stop confirmation accepted'
      );
      expect(input.ledger.stopConfirmationAttempt.readback.category).toBe(
        kind === 'read-failure'
          ? 'read-failed'
          : kind === 'different-action'
            ? 'not-found'
            : kind === 'unknown-state'
              ? 'invalid-state'
              : 'observed'
      );
      expect(JSON.stringify(input.ledger)).not.toMatch(/PRIVATE_/);
      expect(input.click).toHaveBeenCalledOnce();
      expect(input.post).not.toHaveBeenCalled();
      if (kind === 'save-failure')
        expect(input.ledger.stopConfirmationDiagnosticSaveFailed).toBe(true);
    }
  );
  it('does not borrow cleanup time for diagnostic readback', async () => {
    vi.useFakeTimers();
    const input = fixture();
    input.deadline = Date.now() + 90_000;
    vi.mocked(input.page.waitForResponse).mockImplementation(async () => {
      // A delayed event-loop wake must not let readback consume cleanup time.
      vi.setSystemTime(Date.now() + 80_000);
      const error = new Error('timeout');
      error.name = 'TimeoutError';
      throw error;
    });
    await expect(confirmAwakeDispatchStop(input)).rejects.toThrow(
      'Scoped stop confirmation accepted'
    );
    expect(input.ledger.stopConfirmationAttempt.readback.category).toBe('deadline-exhausted');
    expect(
      vi.mocked(input.get).mock.calls.filter(([url]) => url.endsWith('/sam/turns'))
    ).toHaveLength(0);
    expect(input.post).not.toHaveBeenCalled();
  });
  it.each(['sleeping', 'stale-node', 'stale-agent', 'other-node', 'other-session'])(
    'never approves a %s runtime',
    async (state) => {
      const input = fixture();
      if (state === 'sleeping') input.workspace.status = 'stopped';
      if (state === 'stale-node') input.node.lastHeartbeatAt = new Date(0).toISOString();
      if (state === 'stale-agent') input.agent.lastHeartbeatAt = 0;
      if (state === 'other-node') input.agent.nodeId = 'other';
      if (state === 'other-session') input.agent.chatSessionId = 'other';
      await expect(confirmAwakeDispatchStop(input)).rejects.toThrow();
      expect(input.click).not.toHaveBeenCalled();
      expect(input.post).not.toHaveBeenCalled();
      expect(input.ledger.stopConfirmation).toBeUndefined();
    }
  );
  it('does not let fallback cleanup conceal a remaining workspace', async () => {
    const input = fixture();
    const original = input.get;
    input.get = async (url) =>
      url.endsWith('/workspaces') ? ([{ id: 'workspace' }] as unknown as Json) : original(url);
    await expect(confirmAwakeDispatchStop(input)).rejects.toThrow('before fallback cleanup');
    expect(input.ledger.stopConfirmation).toBeUndefined();
  });
  it('rejects a changed result on repeated confirmation', async () => {
    const input = fixture();
    input.post.mockResolvedValueOnce({ action: { ...input.action, result_json: '{}' } });
    await expect(confirmAwakeDispatchStop(input)).rejects.toThrow('same completed receipt');
    expect(input.ledger.stopConfirmation).toBeUndefined();
  });
  it('never begins confirmation when the work budget cannot fit its request', async () => {
    const input = fixture();
    input.deadline = Date.now() + 1_000;
    await expect(confirmAwakeDispatchStop(input)).rejects.toThrow('work deadline');
    expect(input.click).not.toHaveBeenCalled();
  });
});
