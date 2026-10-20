import type { Page } from '@playwright/test';
import { describe, expect, it, vi } from 'vitest';

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
    record: vi.fn(async (turns: Turn[]) => turns),
    workspace,
    node,
    agent,
    click,
    action,
    filter,
  };
}

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
