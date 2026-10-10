/**
 * Which bootstrap branch delivered the wake's first prompt. A fresh start sends
 * `visibleInitialPrompt`; a session restored through LoadSession never receives it, and says
 * so (`initialPromptSent: false`) so the TaskRunner can queue the prompt it still needs.
 * Only the VM boundary (`node-agent`) is mocked; bootstrap and the snapshot record are real.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { prepareSessionSnapshot } from '../../../src/services/session-snapshot-prepare';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const vm = vi.hoisted(() => ({
  create: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
  restore: vi.fn<(...args: unknown[]) => Promise<{ status: string }>>(async () => ({
    status: 'restored',
  })),
  start: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
}));

vi.mock('../../../src/services/node-agent', () => ({
  createAgentSessionOnNode: vm.create,
  restoreAgentSessionOnNode: vm.restore,
  startAgentSessionOnNode: vm.start,
}));
vi.mock('../../../src/services/mcp-token', () => ({
  generateMcpToken: () => 'sam-session-token',
  revokeMcpToken: vi.fn(async () => undefined),
  storeMcpToken: vi.fn(async () => undefined),
}));
vi.mock('../../../src/services/project-data', () => ({
  createAcpSession: vi.fn(async () => ({ id: 'acp-1' })),
  getAcpSession: vi.fn(async () => null),
  persistMessage: vi.fn(async () => undefined),
  transitionAcpSession: vi.fn(async () => undefined),
  prepareAcpSessionForFreshStart: vi.fn(async () => ({ id: 'acp-1' })),
}));

const { startSamAwareAgentSession } = await import('../../../src/services/agent-session-bootstrap');

const WAKE_PROMPT = 'Resume your assigned task from the persisted transcript.';
let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

function env(): Env {
  return {
    BASE_DOMAIN: 'example.com',
    ENCRYPTION_KEY: Buffer.alloc(32, 5).toString('base64'),
    KV: { get: vi.fn(), put: vi.fn(), delete: vi.fn() },
  } as unknown as Env;
}

function input(extra: Record<string, unknown> = {}) {
  return {
    nodeId: 'node-1',
    workspaceId: 'ws-1',
    projectId: 'proj-1',
    userId: 'user-1',
    chatSessionId: 'chat-1',
    agentSessionId: 'agent-1',
    label: 'Task: work',
    agentType: 'claude-code',
    visibleInitialPrompt: WAKE_PROMPT,
    promptKind: 'task',
    taskContext: { taskId: 'task-1', taskMode: 'task' },
    actor: { type: 'system', id: 'task-runner', reasonPrefix: 'test' },
    ...extra,
  } as Parameters<typeof startSamAwareAgentSession>[2];
}

/** A task that ran and slept, leaving the snapshot record a wake restores from. */
async function sleptTask(): Promise<void> {
  await startSamAwareAgentSession(db, env(), input());
  await prepareSessionSnapshot(db, env(), {
    workspaceId: 'ws-1',
    nodeId: 'node-1',
    projectId: 'proj-1',
    userId: 'user-1',
    chatSessionId: 'chat-1',
    agentSessionId: 'agent-1',
    runtime: 'vm',
  });
  vi.clearAllMocks();
}

const wake = () =>
  startSamAwareAgentSession(
    db,
    env(),
    input({
      agentSessionId: 'agent-2',
      workspaceId: 'ws-2',
      restoreSnapshotChatSessionId: 'chat-1',
    })
  );

beforeEach(() => {
  vi.clearAllMocks();
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [
    schema.mcpConnections,
    schema.agentSessions,
    schema.projects,
    schema.agentSettings,
    schema.sessionSnapshots,
    schema.nodes,
    schema.workspaces,
    schema.users,
    schema.tasks,
    schema.agentProfiles,
  ]);
  sqlite.exec(
    'CREATE UNIQUE INDEX session_snapshots_chat_unique ON session_snapshots(chat_session_id)'
  );
  db = drizzle(createSqliteD1(sqlite), { schema });
});

afterEach(() => sqlite.close());

describe('startSamAwareAgentSession reports whether the first prompt was sent', () => {
  it('sends it on an ordinary start', async () => {
    const result = await startSamAwareAgentSession(db, env(), input());

    expect(result.initialPromptSent).toBe(true);
    expect(vm.start).toHaveBeenCalledOnce();
    expect(vm.start.mock.calls[0]?.[4]).toBe(WAKE_PROMPT);
  });

  it('does not send it when the restore resumes the saved session', async () => {
    await sleptTask();
    vm.restore.mockResolvedValueOnce({ status: 'restored' });

    const result = await wake();

    expect(vm.restore).toHaveBeenCalledOnce();
    expect(vm.start).not.toHaveBeenCalled();
    expect(result.initialPromptSent).toBe(false);
  });

  it('sends it once when a degraded restore starts the agent fresh', async () => {
    await sleptTask();
    vm.restore.mockResolvedValueOnce({ status: 'degraded' });

    const result = await wake();

    expect(vm.start).toHaveBeenCalledOnce();
    expect(vm.start.mock.calls[0]?.[4]).toBe(WAKE_PROMPT);
    expect(result.initialPromptSent).toBe(true);
  });
});
