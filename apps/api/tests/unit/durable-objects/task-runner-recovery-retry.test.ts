/** Real bootstrap, token lifecycle and recovery SQL; only VM HTTP/DO/KV are faked. */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import { handleAgentSession } from '../../../src/durable-objects/task-runner/agent-session-step';
import { failTask } from '../../../src/durable-objects/task-runner/state-machine';
import type {
  TaskRunnerContext,
  TaskRunnerState,
} from '../../../src/durable-objects/task-runner/types';
import type { Env } from '../../../src/env';
import { startSamAwareAgentSession } from '../../../src/services/agent-session-bootstrap';
import { validateMcpToken } from '../../../src/services/mcp-token';
import {
  isSessionRecoveryTaskAuthorized,
  SessionRecoveryAuthorityRevokedError,
} from '../../../src/services/session-recovery-authority';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const vm = vi.hoisted(() => ({ create: vi.fn(), restore: vi.fn(), start: vi.fn(), stop: vi.fn() }));
vi.mock('../../../src/services/node-agent', () => ({
  createAgentSessionOnNode: vm.create,
  restoreAgentSessionOnNode: vm.restore,
  startAgentSessionOnNode: vm.start,
  stopWorkspaceOnNode: vm.stop,
}));

let sqlite: Database.Database;
let env: Env;
let rc: TaskRunnerContext;
let storedState: TaskRunnerState;
let background: Promise<unknown>[];
let tokens: Map<string, string>;
let chat: { id: string; status: string; workspaceId: string; taskId: string };
let wake: ReturnType<typeof vi.fn>;

function state(sourceTaskId: string | null = null): TaskRunnerState {
  return {
    version: 1,
    taskId: 'recovery',
    projectId: 'project',
    userId: 'user',
    currentStep: 'agent_session',
    completed: false,
    retryCount: 0,
    stepResults: {
      nodeId: 'node',
      workspaceId: 'replacement',
      chatSessionId: 'chat',
      agentSessionId: null,
      agentStarted: false,
      mcpToken: null,
      autoProvisioned: false,
      provisionedVmSize: null,
    },
    config: {
      taskTitle: 'Wake preserved conversation',
      taskDescription: 'Continue the preserved work.',
      taskMode: 'conversation',
      agentType: 'openai-codex',
      chatSessionId: 'chat',
      resumeSnapshotChatSessionId: 'chat',
      recoverySourceTaskId: sourceTaskId,
    },
    createdAt: Date.now(),
    lastStepAt: Date.now(),
    lastD1Step: 'agent_session',
  } as TaskRunnerState;
}

function seed(sourceTaskId: string | null = null) {
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO tasks (id, project_id, user_id, title, status, chat_session_id, workspace_id, triggered_by, recovery_source_task_id, created_at, updated_at)
    VALUES ('recovery', 'project', 'user', 'Wake conversation', 'delegated', 'chat', 'replacement', 'session-recovery', ?, ?, ?)`
    )
    .run(sourceTaskId, now, now);
  if (sourceTaskId) {
    sqlite
      .prepare(
        `INSERT INTO tasks (id, project_id, user_id, title, status, created_at, updated_at)
      VALUES (?, 'project', 'user', 'Original conversation', 'awaiting_followup', ?, ?)`
      )
      .run(sourceTaskId, now, now);
  }
  sqlite
    .prepare(
      `INSERT INTO workspaces (id, project_id, user_id, name, repository, branch, status, node_id, created_at, updated_at)
    VALUES ('replacement', 'project', 'user', 'Restored workspace', 'org/repo', 'main', 'running', 'node', ?, ?)`
    )
    .run(now, now);
  sqlite
    .prepare(
      `INSERT INTO session_snapshots (id, project_id, user_id, workspace_id, chat_session_id, runtime, status, degradation,
    manifest_r2_key, expires_at, sleeping_at, sleep_status, recovery_status, recovery_task_id, recovery_workspace_id, recovery_claimed_at, recovery_attempts, created_at, updated_at)
    VALUES ('snapshot', 'project', 'user', 'original', 'chat', 'vm', 'available', 'none', 'snapshots/chat/manifest.json', ?, ?, 'sleeping', 'waking', 'recovery', 'replacement', ?, 1, ?, ?)`
    )
    .run(new Date(Date.now() + 86400000).toISOString(), now, now, now, now);
  return state(sourceTaskId);
}

function snapshot() {
  return sqlite
    .prepare(
      'SELECT recovery_status, recovery_task_id, sleeping_at, recovery_failed_at FROM session_snapshots WHERE id = ?'
    )
    .get('snapshot');
}

beforeEach(() => {
  vi.resetAllMocks();
  vm.create.mockResolvedValue(undefined);
  vm.restore.mockResolvedValue({ status: 'restored' });
  vm.start.mockResolvedValue(undefined);
  vm.stop.mockResolvedValue(undefined);
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  tokens = new Map();
  background = [];
  const acp = new Map<string, { id: string; chatSessionId: string; status: string }>();
  chat = { id: 'chat', status: 'sleeping', workspaceId: 'original', taskId: 'source' };
  wake = vi.fn(async (id: string, workspaceId: string, taskId: string) => {
    expect(id).toBe(chat.id);
    chat = { ...chat, status: 'active', workspaceId, taskId };
    return true;
  });
  const projectData = {
    ensureProjectId: vi.fn(async () => undefined),
    getSession: vi.fn(async () => ({ ...chat })),
    wakeSession: wake,
    sleepSession: vi.fn(async () => {
      chat.status = 'sleeping';
      return true;
    }),
    getAcpSession: vi.fn(async (id: string) => acp.get(id) ?? null),
    createAcpSession: vi.fn(async (input: { id: string; chatSessionId: string }) => {
      const session = { ...input, status: 'pending' };
      acp.set(input.id, session);
      return session;
    }),
    transitionAcpSession: vi.fn(async (id: string, status: string) => {
      const session = acp.get(id);
      if (!session) throw new Error('ACP session missing');
      session.status = status;
      return session;
    }),
    persistMessage: vi.fn(async () => ({ id: 'message', sessionId: 'chat', role: 'system' })),
    admitProjectEvent: vi.fn(async () => ({ status: 'admitted', eventId: 'event' })),
    publishSessionWakeProgress: vi.fn(async () => undefined),
    notifyTaskTerminal: vi.fn(async () => undefined),
  };
  env = {
    BASE_DOMAIN: 'example.test',
    ENCRYPTION_KEY: Buffer.alloc(32, 5).toString('base64'),
    DATABASE: createSqliteD1(sqlite),
    KV: {
      put: async (key: string, value: string) => {
        tokens.set(key, value);
      },
      get: async (key: string, options?: { type?: string }) => {
        const value = tokens.get(key) ?? null;
        return value && options?.type === 'json' ? JSON.parse(value) : value;
      },
      delete: async (key: string) => {
        tokens.delete(key);
      },
    },
    PROJECT_DATA: { idFromName: (id: string) => id, get: () => projectData },
    NODE_LIFECYCLE: {
      idFromName: (id: string) => id,
      get: () => ({ scheduleWorkspaceDeletion: async () => undefined }),
    },
  } as unknown as Env;
  rc = {
    env,
    ctx: {
      storage: {
        put: async (_key: string, value: TaskRunnerState) => {
          storedState = structuredClone(value);
        },
      },
      waitUntil: (promise: Promise<unknown>) => {
        background.push(promise);
      },
    },
    updateD1ExecutionStep: async () => undefined,
    assertRecoveryAuthority: async (input: TaskRunnerState) => {
      if (!input.config.recoverySourceTaskId) return;
      if (
        !(await isSessionRecoveryTaskAuthorized(env.DATABASE, {
          recoveryTaskId: input.taskId,
          sourceTaskId: input.config.recoverySourceTaskId,
          projectId: input.projectId,
          chatSessionId: input.config.resumeSnapshotChatSessionId!,
        }))
      )
        throw new SessionRecoveryAuthorityRevokedError();
    },
  } as TaskRunnerContext;
});

afterEach(async () => {
  await Promise.allSettled(background);
  sqlite.close();
});

describe('recovery step retries retain their claim and token', () => {
  it.each([null, 'source'])(
    'commits after transient restore 524 (source guard: %s)',
    async (sourceTaskId) => {
      const input = seed(sourceTaskId);
      vm.restore.mockRejectedValueOnce(new Error('VM restore: HTTP 524'));

      await expect(handleAgentSession(input, rc)).rejects.toThrow('HTTP 524');
      expect(snapshot()).toMatchObject({
        recovery_status: 'waking',
        recovery_task_id: 'recovery',
        recovery_failed_at: null,
      });
      expect(chat.status).toBe('sleeping');
      expect(wake).not.toHaveBeenCalled();
      const token = storedState.stepResults.mcpToken!;
      expect(await validateMcpToken(env.KV, token)).toMatchObject({
        taskId: 'recovery',
        chatSessionId: 'chat',
      });

      // Reload from durable state as a fresh alarm does; no in-memory ownership shortcut.
      const retry = structuredClone(storedState);
      await handleAgentSession(retry, rc);

      expect(snapshot()).toMatchObject({ recovery_status: 'restored', sleeping_at: null });
      expect(chat).toMatchObject({
        status: 'active',
        workspaceId: 'replacement',
        taskId: 'recovery',
      });
      expect(sqlite.prepare('SELECT status FROM tasks WHERE id = ?').get('recovery')).toEqual({
        status: 'in_progress',
      });
      expect(retry.currentStep).toBe('running');
      expect(retry.config.resumeSnapshotChatSessionId).toBeNull();
      expect(vm.restore).toHaveBeenCalledTimes(2);
      expect(vm.restore.mock.calls[1]?.at(-1)).toMatchObject({
        sourceTaskGuard: sourceTaskId
          ? { taskId: sourceTaskId, projectId: 'project', chatSessionId: 'chat' }
          : undefined,
      });
      expect(vm.start).not.toHaveBeenCalled();
      expect(vm.create.mock.calls[1]?.[8]).toEqual([
        { name: 'sam-mcp', url: 'https://api.example.test/mcp', token },
      ]);
      expect(await validateMcpToken(env.KV, token)).toMatchObject({ taskId: 'recovery' });
    }
  );

  it('mints a live token on retry after the first token ownership write failed', async () => {
    const input = seed();
    const persist = rc.ctx.storage.put;
    let rejectedToken: string | null = null;
    rc.ctx.storage.put = (async (key: string, value: TaskRunnerState) => {
      if (value.stepResults.mcpToken && !rejectedToken) {
        rejectedToken = value.stepResults.mcpToken;
        throw new Error('Token ownership write failed');
      }
      await persist(key, value);
    }) as typeof rc.ctx.storage.put;

    await expect(handleAgentSession(input, rc)).rejects.toThrow('Token ownership write failed');
    expect(rejectedToken).toEqual(expect.any(String));
    expect(await validateMcpToken(env.KV, rejectedToken!)).toBeNull();
    expect(vm.create).not.toHaveBeenCalled();

    // The alarm catch persists the SAME mutable state while scheduling its retry.
    // It must not turn an uncommitted, revoked bootstrap token into durable state.
    await rc.ctx.storage.put('state', input);
    const retry = structuredClone(storedState);
    await handleAgentSession(retry, rc);
    expect(retry.stepResults.mcpToken).not.toBe(rejectedToken);
    expect(await validateMcpToken(env.KV, retry.stepResults.mcpToken!)).toMatchObject({
      taskId: 'recovery',
    });
    expect(vm.create.mock.calls[0]?.[8]).toEqual([
      { name: 'sam-mcp', url: 'https://api.example.test/mcp', token: retry.stepResults.mcpToken },
    ]);
    expect(snapshot()).toMatchObject({ recovery_status: 'restored', sleeping_at: null });
  });

  it('rejects the retry if its durable source loses authority between alarms', async () => {
    const input = seed('source');
    vm.restore.mockRejectedValueOnce(new Error('VM restore: HTTP 524'));
    await expect(handleAgentSession(input, rc)).rejects.toThrow('HTTP 524');
    sqlite.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = 'source'").run();

    await expect(handleAgentSession(structuredClone(storedState), rc)).rejects.toThrow(
      'authority was revoked'
    );
    expect(vm.restore).toHaveBeenCalledOnce();
    expect(wake).not.toHaveBeenCalled();
    expect(snapshot()).toMatchObject({ sleeping_at: expect.any(String) });
  });

  it('terminal failure closes the claim and revokes the token retained during retry', async () => {
    const input = seed('source');
    vm.restore.mockRejectedValueOnce(new Error('VM restore: HTTP 524'));
    await expect(handleAgentSession(input, rc)).rejects.toThrow('HTTP 524');
    const token = input.stepResults.mcpToken!;
    expect(await validateMcpToken(env.KV, token)).toMatchObject({ taskId: 'recovery' });

    await failTask(input, 'Agent session retry budget exhausted', rc);

    expect(snapshot()).toMatchObject({
      recovery_status: 'failed',
      recovery_failed_at: expect.any(String),
      sleeping_at: expect.any(String),
    });
    expect(await validateMcpToken(env.KV, token)).toBeNull();
    expect(input.stepResults.mcpToken).toBeNull();
    expect(input.completed).toBe(true);
    expect(chat.status).toBe('sleeping');
    expect(sqlite.prepare('SELECT status FROM tasks WHERE id = ?').get('recovery')).toEqual({
      status: 'failed',
    });
    expect(vm.stop).toHaveBeenCalledOnce();
    expect(sqlite.prepare('SELECT chat_session_id FROM tasks WHERE id = ?').get('source')).toEqual({
      chat_session_id: 'chat',
    });
  });
});

describe('bootstrap retains responsibility until token handoff succeeds', () => {
  function bootstrapInput() {
    return {
      nodeId: 'node',
      workspaceId: 'replacement',
      projectId: 'project',
      userId: 'user',
      agentSessionId: 'agent',
      label: 'Instant conversation',
      agentType: 'openai-codex',
      visibleInitialPrompt: 'Continue',
      promptKind: 'conversation' as const,
      actor: { type: 'user' as const, id: 'user', reasonPrefix: 'Instant start' },
    };
  }

  it('keeps the token usable after a durable owner accepted it and agent start failed', async () => {
    let ownedToken: string | undefined;
    vm.start.mockRejectedValueOnce(new Error('Agent install failed'));
    await expect(
      startSamAwareAgentSession(drizzle(env.DATABASE, { schema }), env, {
        ...bootstrapInput(),
        onMcpToken: async (token) => {
          ownedToken = token;
        },
      })
    ).rejects.toThrow('Agent install failed');
    expect(ownedToken).toBeTruthy();
    expect(await validateMcpToken(env.KV, ownedToken!)).toMatchObject({
      projectId: 'project',
      agentSessionId: 'agent',
    });
  });

  it('revokes a generated token when no durable owner accepted it', async () => {
    vm.start.mockRejectedValueOnce(new Error('Agent install failed'));
    await expect(
      startSamAwareAgentSession(drizzle(env.DATABASE, { schema }), env, bootstrapInput())
    ).rejects.toThrow('Agent install failed');
    expect(vm.start).toHaveBeenCalledOnce();
    const token = vm.start.mock.calls[0]?.[7][0].token as string;
    expect(await validateMcpToken(env.KV, token)).toBeNull();
    expect(tokens.size).toBe(0);
  });

  it('revokes a generated token when durable ownership persistence rejects', async () => {
    let issuedToken: string | undefined;
    await expect(
      startSamAwareAgentSession(drizzle(env.DATABASE, { schema }), env, {
        ...bootstrapInput(),
        onMcpToken: async (token) => {
          issuedToken = token;
          throw new Error('Storage unavailable');
        },
      })
    ).rejects.toThrow('Storage unavailable');
    expect(issuedToken).toBeTruthy();
    expect(await validateMcpToken(env.KV, issuedToken!)).toBeNull();
    expect(vm.create).not.toHaveBeenCalled();
  });
});
