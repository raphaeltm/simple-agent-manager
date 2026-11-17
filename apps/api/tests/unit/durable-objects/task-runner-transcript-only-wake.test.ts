/**
 * Waking a VM chat whose sleep fell back to transcript-only (idea 01M7MMR6KK57PVFS3E57NJZ3N0).
 *
 * The bounded sleep fallback recorded no recovery point, so the control plane's restore
 * answer is `{available:false, reason:'transcript_only_sleep_fallback'}` and the vm-agent
 * answers the wake with `{status:'transcript-replay', reason}`. The bootstrap threw on that
 * (`Strict session restore failed (transcript-replay)`), so every wake of such a chat failed
 * and the chat was stuck. Policy a3780107 requires starting fresh from the transcript.
 *
 * The VM answer here is the shared contract fixture the Go handler test pins
 * (`session_snapshot_restore_contract_test.go`), and the control plane's answer is pinned
 * against the real route in `session-sleep-bounded-fallback.test.ts`. This test enters
 * through the real TaskRunner step (`handleAgentSession`) with the real bootstrap, MCP token
 * lifecycle and recovery SQL; only VM HTTP, ProjectData and KV are faked.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import { handleAgentSession } from '../../../src/durable-objects/task-runner/agent-session-step';
import type {
  TaskRunnerContext,
  TaskRunnerState,
} from '../../../src/durable-objects/task-runner/types';
import type { Env } from '../../../src/env';
import {
  serializeSessionSleepFallbackRecord,
  type SessionSleepFallbackRecord,
} from '../../../src/services/session-sleep-episode';
import { sessionRecoveryInitialPrompt } from '../../../src/services/session-sleep-fallback-messages';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      public ctx: DurableObjectState,
      public env: Env
    ) {}
  },
}));

const vm = vi.hoisted(() => ({ create: vi.fn(), restore: vi.fn(), start: vi.fn(), stop: vi.fn() }));
vi.mock('../../../src/services/node-agent', () => ({
  createAgentSessionOnNode: vm.create,
  restoreAgentSessionOnNode: vm.restore,
  startAgentSessionOnNode: vm.start,
  stopWorkspaceOnNode: vm.stop,
}));

const CONTRACT = JSON.parse(
  readFileSync(
    join(
      __dirname,
      '../../../../../tests/fixtures/session-snapshot-restore-transcript-only-v1.json'
    ),
    'utf8'
  )
) as { vmAgentRestoreResponse: { status: string; reason: string } };

/** What the bounded fallback stores when no capture recorded a Git commit. */
const TRANSCRIPT_ONLY_RECORD: SessionSleepFallbackRecord = {
  version: 1,
  outcome: 'slept',
  trigger: 'attempt_budget',
  blockedReason: null,
  decidedAt: '2026-11-17T07:36:00.000Z',
  episodeStartedAt: '2026-11-17T06:42:00.000Z',
  failedAttempts: 4,
  lastError: 'WIP artifact exceeds the snapshot budget',
  recoveryPoint: null,
};
/** The wake prompt `createRecoveryTask` gives this task (`session-recovery-task.ts`). */
const WAKE_PROMPT = sessionRecoveryInitialPrompt(TRANSCRIPT_ONLY_RECORD);

let sqlite: Database.Database;
let env: Env;
let rc: TaskRunnerContext;
let storedState: TaskRunnerState;
let background: Promise<unknown>[];
let chat: { id: string; status: string; workspaceId: string; taskId: string };
let systemMessages: string[];
let freshStarts: Array<{ id: string; reason: unknown; metadata: unknown }>;
let messagesById: Map<string, { role: string; content: string }>;
/** The ACP session's first `running` transition finds it already failed, as after a crash. */
let failFirstRunningTransition: boolean;

function seed(): TaskRunnerState {
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO tasks (id, project_id, user_id, title, status, chat_session_id, workspace_id, triggered_by, created_at, updated_at)
    VALUES ('recovery', 'project', 'user', 'Wake conversation', 'delegated', 'chat', 'replacement', 'session-recovery', ?, ?)`
    )
    .run(now, now);
  sqlite
    .prepare(
      `INSERT INTO workspaces (id, project_id, user_id, name, repository, branch, status, node_id, chat_session_id, created_at, updated_at)
    VALUES ('replacement', 'project', 'user', 'Wake workspace', 'org/repo', 'sam/feature', 'running', 'node', 'chat', ?, ?)`
    )
    .run(now, now);
  // The row the bounded fallback leaves, already claimed by this wake.
  sqlite
    .prepare(
      `INSERT INTO session_snapshots (id, project_id, user_id, workspace_id, chat_session_id, runtime, status, degradation,
    manifest_r2_key, expires_at, sleeping_at, sleep_status, sleep_fallback_json, recovery_status, recovery_task_id,
    recovery_workspace_id, recovery_claimed_at, recovery_attempts, created_at, updated_at)
    VALUES ('snapshot', 'project', 'user', 'original', 'chat', 'vm', 'degraded', 'transcript-only',
    'snapshots/chat/manifest.json', ?, ?, 'sleeping', ?, 'waking', 'recovery', 'replacement', ?, 1, ?, ?)`
    )
    .run(
      new Date(Date.now() + 86_400_000).toISOString(),
      now,
      serializeSessionSleepFallbackRecord(TRANSCRIPT_ONLY_RECORD),
      now,
      now,
      now
    );
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
      taskTitle: 'Wake sleeping conversation',
      taskDescription: WAKE_PROMPT,
      taskMode: 'conversation',
      agentType: 'openai-codex',
      chatSessionId: 'chat',
      resumeSnapshotChatSessionId: 'chat',
      recoverySourceTaskId: null,
    },
    createdAt: Date.now(),
    lastStepAt: Date.now(),
    lastD1Step: 'agent_session',
  } as TaskRunnerState;
}

function snapshot() {
  return sqlite
    .prepare(
      'SELECT recovery_status, sleeping_at, sleep_fallback_json FROM session_snapshots WHERE id = ?'
    )
    .get('snapshot');
}

function taskStatus() {
  return sqlite.prepare('SELECT status FROM tasks WHERE id = ?').get('recovery');
}

beforeEach(() => {
  vi.resetAllMocks();
  vm.create.mockResolvedValue(undefined);
  vm.start.mockResolvedValue(undefined);
  vm.stop.mockResolvedValue(undefined);
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  const tokens = new Map<string, string>();
  background = [];
  systemMessages = [];
  freshStarts = [];
  messagesById = new Map();
  failFirstRunningTransition = false;
  chat = { id: 'chat', status: 'sleeping', workspaceId: 'original', taskId: 'source' };
  const acp = new Map<string, { id: string; chatSessionId: string; status: string }>();
  const projectData = {
    ensureProjectId: vi.fn(async () => undefined),
    getSession: vi.fn(async () => ({ ...chat })),
    wakeSession: vi.fn(async (id: string, workspaceId: string, taskId: string) => {
      expect(id).toBe(chat.id);
      chat = { ...chat, status: 'active', workspaceId, taskId };
      return true;
    }),
    sleepSession: vi.fn(async () => true),
    repairSessionForSnapshotRecovery: vi.fn(async () => false),
    getAcpSession: vi.fn(async (id: string) => acp.get(id) ?? null),
    createAcpSession: vi.fn(async (input: { id: string; chatSessionId: string }) => {
      const session = { ...input, status: 'pending' };
      acp.set(input.id, session);
      return session;
    }),
    transitionAcpSession: vi.fn(async (id: string, status: string) => {
      const session = acp.get(id);
      if (!session) throw new Error('ACP session missing');
      if (status === 'running' && failFirstRunningTransition) {
        failFirstRunningTransition = false;
        session.status = 'failed';
        throw new Error('Invalid ACP session transition: failed -> running');
      }
      session.status = status;
      return session;
    }),
    prepareAcpSessionForFreshStart: vi.fn(
      async (id: string, opts: { reason?: string; metadata?: unknown }) => {
        const session = acp.get(id);
        if (!session) throw new Error('ACP session missing');
        session.status = 'assigned';
        freshStarts.push({ id, reason: opts.reason, metadata: opts.metadata });
        return session;
      }
    ),
    // Mirrors the DO's duplicate rule (`resolveDuplicateMessage`): a message id that is
    // reused must carry the same role and content, or the write throws.
    persistMessage: vi.fn(
      async (_chat: string, role: string, content: string, _meta: unknown, id?: string) => {
        if (id) {
          const existing = messagesById.get(id);
          if (existing && (existing.role !== role || existing.content !== content)) {
            throw new Error(`Message id ${id} already belongs to a different transcript entry`);
          }
          if (existing) return { id, sessionId: 'chat', role };
          messagesById.set(id, { role, content });
        }
        if (role === 'system') systemMessages.push(content);
        return { id: id ?? 'message', sessionId: 'chat', role };
      }
    ),
    admitProjectEvent: vi.fn(async () => ({ status: 'admitted', eventId: 'event' })),
    publishSessionWakeProgress: vi.fn(async () => undefined),
    notifyTaskTerminal: vi.fn(async () => undefined),
    reconcileTaskWaits: vi.fn(async () => undefined),
    failSession: vi.fn(async () => true),
    cleanupWorkspaceActivity: vi.fn(async () => undefined),
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
        transaction: async <T>(callback: (transaction: DurableObjectTransaction) => Promise<T>) =>
          callback(rc.ctx.storage as unknown as DurableObjectTransaction),
        get: async () => structuredClone(storedState),
        setAlarm: vi.fn(async () => undefined),
        deleteAlarm: vi.fn(async () => undefined),
        put: async (_key: string, value: TaskRunnerState) => {
          storedState = structuredClone(value);
        },
      },
      waitUntil: (promise: Promise<unknown>) => {
        background.push(promise);
      },
    },
    updateD1ExecutionStep: async () => undefined,
    assertRecoveryAuthority: async () => undefined,
  } as TaskRunnerContext;
});

afterEach(async () => {
  await Promise.allSettled(background);
  sqlite.close();
});

describe('waking a VM chat whose sleep fell back to transcript-only', () => {
  it('starts the agent fresh from the transcript on the vm-agent transcript-replay answer', async () => {
    const state = seed();
    vm.restore.mockResolvedValue(structuredClone(CONTRACT.vmAgentRestoreResponse));

    await handleAgentSession(state, rc);

    // The restore ran, then a fresh agent started with the transcript-only wake prompt.
    expect(vm.restore).toHaveBeenCalledOnce();
    expect(vm.restore.mock.calls[0]?.[5]).toMatchObject({ chatSessionId: 'chat', runtime: 'vm' });
    expect(vm.start).toHaveBeenCalledOnce();
    const startArgs = vm.start.mock.calls[0]!;
    expect(startArgs[4]).toBe(WAKE_PROMPT);
    expect(WAKE_PROMPT).toContain('This is a fresh agent session');
    expect(WAKE_PROMPT).toContain('Never claim an exact restore');
    // The ACP session was reset for the fresh start, labelled with why.
    expect(freshStarts).toEqual([
      expect.objectContaining({
        reason: expect.stringContaining('transcript-only sleep fallback'),
        metadata: expect.objectContaining({ freshStartReason: 'transcript_only' }),
      }),
    ]);
    // The chat is told nothing was restored, and is not told a snapshot was.
    const wakeNotices = systemMessages.filter((message) => /transcript/.test(message));
    expect(wakeNotices).toHaveLength(1);
    expect(wakeNotices[0]).toContain('saved no snapshot or Git recovery point');
    expect(wakeNotices[0]).toContain('were not restored');
    expect(systemMessages.join('\n')).not.toMatch(/restored this sleeping conversation/);

    // The wake commits: the snapshot leaves sleep, the chat is live, the task runs.
    expect(snapshot()).toMatchObject({
      recovery_status: 'restored',
      sleeping_at: null,
      sleep_fallback_json: null,
    });
    expect(chat).toMatchObject({
      status: 'active',
      workspaceId: 'replacement',
      taskId: 'recovery',
    });
    expect(taskStatus()).toEqual({ status: 'in_progress' });
    expect(state.currentStep).toBe('running');
    // No files came back, so nothing may release the source workspace as restored.
    expect(storedState.stepResults.snapshotRestoreComplete).toBe(false);
  });

  // Controls: the tolerance covers exactly the transcript-only fallback, so the suite would
  // not pass if the classifier simply accepted every non-`restored` status.
  it.each([
    [
      'a snapshot that vanished after the claim',
      { status: 'transcript-replay', reason: 'snapshot_missing_or_unavailable' },
      'Strict session restore failed (transcript-replay: snapshot_missing_or_unavailable)',
    ],
    [
      'a transcript replay with no reason',
      { status: 'transcript-replay' },
      'Strict session restore failed (transcript-replay)',
    ],
    ['an unknown status', { status: 'resumed' }, 'Strict session restore failed (resumed)'],
    [
      'another status carrying the transcript-only reason',
      { status: 'resumed', reason: 'transcript_only_sleep_fallback' },
      'Strict session restore failed (resumed: transcript_only_sleep_fallback)',
    ],
  ])('still fails the wake on %s', async (_name, answer, message) => {
    const state = seed();
    vm.restore.mockResolvedValue(answer);

    await expect(handleAgentSession(state, rc)).rejects.toThrow(message);

    expect(vm.start).not.toHaveBeenCalled();
    expect(systemMessages).toEqual([]);
    expect(snapshot()).toMatchObject({ recovery_status: 'waking' });
    expect(taskStatus()).toEqual({ status: 'delegated' });
  });

  // The ACP session can already be `failed` when the start marks it running; the bootstrap then
  // resets it and re-persists the fresh-start notice under the same message id. With the wrong
  // wording that write was refused, and every retry of the wake failed the same way.
  it('repairs a failed ACP session without contradicting the transcript-only notice', async () => {
    const state = seed();
    vm.restore.mockResolvedValue(structuredClone(CONTRACT.vmAgentRestoreResponse));
    failFirstRunningTransition = true;

    await handleAgentSession(state, rc);

    expect(freshStarts.map((start) => start.reason)).toEqual([
      expect.stringContaining('transcript-only sleep fallback'),
      expect.stringContaining('transcript-only sleep fallback'),
    ]);
    expect(systemMessages.filter((message) => /transcript/.test(message))).toHaveLength(1);
    expect(taskStatus()).toEqual({ status: 'in_progress' });
  });

  it('still resumes the saved agent session when the restore succeeds', async () => {
    const state = seed();
    vm.restore.mockResolvedValue({ status: 'restored' });

    await handleAgentSession(state, rc);

    expect(vm.start).not.toHaveBeenCalled();
    expect(freshStarts).toEqual([]);
    expect(taskStatus()).toEqual({ status: 'in_progress' });
    expect(storedState.stepResults.snapshotRestoreComplete).toBe(true);
  });
});
