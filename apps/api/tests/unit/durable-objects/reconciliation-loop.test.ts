import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runMigrations } from '../../../src/durable-objects/migrations';
import {
  persistMessageBatchWithSideEffects,
  persistMessageWithSideEffects,
} from '../../../src/durable-objects/project-data/message-persistence';
import {
  computeReconciliationAlarmTime,
  getReconciliationCandidates,
  processReconciliationCandidates,
} from '../../../src/durable-objects/project-data/reconciliation';
import {
  ensureReconciliationEpisode,
  readReconciliationEpisode,
  writeReconciliationEpisode,
} from '../../../src/durable-objects/project-data/reconciliation-episode';
import type { Env } from '../../../src/durable-objects/project-data/types';
import {
  acceptedPromptResponse,
  versionedPromptCapabilities,
} from '../../helpers/vm-prompt-delivery-fixtures';
import { createSqlStorage } from './sql-storage-test-utils';

const boundary = vi.hoisted(() => ({ send: vi.fn(), ai: vi.fn() }));
vi.mock('../../../src/services/node-agent', async (original) => ({
  ...(await original<typeof import('../../../src/services/node-agent')>()),
  nodeAgentRequest: vi.fn(async () => versionedPromptCapabilities('runtime-1')),
  sendPromptToAgentOnNode: boundary.send,
}));
vi.mock('../../../src/durable-objects/project-data/task-runtime-liveness', () => ({
  getLocalTaskRuntimeLiveness: vi.fn(async () => ({
    live: true,
    conclusive: true,
    reason: 'task_acp_session_live',
    nodeId: 'node-1',
    userId: 'user-1',
    deliveryTarget: { nodeId: 'node-1', userId: 'user-1' },
  })),
}));

const IDLE = 6 * 60 * 1000;
const permanent = `Warning: Model metadata for \`gpt-6.1-sol\` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.\n\n{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account."}}\n\n`;

describe('bounded delivered check-in episodes', () => {
  let db: Database.Database;
  let sql: SqlStorage;
  let env: Env;
  const hooks = {
    recalculateAlarm: vi.fn(async () => {}),
    scheduleSummarySync: vi.fn(),
    broadcastEvent: vi.fn(),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-05T10:00:00Z'));
    vi.clearAllMocks();
    db = new Database(':memory:');
    sql = createSqlStorage(db);
    runMigrations(sql);
    env = {
      DATABASE: {
        prepare: () => ({
          bind: (taskId: string) => ({
            first: async () => ({
              task_mode: 'task',
              status: 'in_progress',
              project_id: 'project-1',
              workspace_id: `ws-${taskId}`,
              chat_session_id: `session-${taskId}`,
            }),
          }),
        }),
      },
      AI: { run: boundary.ai },
    } as unknown as Env;
    boundary.send.mockImplementation(async (_node, _workspace, acp, ...args) =>
      acceptedPromptResponse(acp, args[4]?.deliveryId ?? '', 'runtime-1', Date.now())
    );
    boundary.ai.mockResolvedValue({
      answers: { stall_status: { value: 'stalled', probabilities: { stalled: 0.95 } } },
    });
    seed('1');
  });
  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  function seed(id: string) {
    const old = Date.now() - IDLE;
    sql.exec(
      `INSERT INTO chat_sessions (id, workspace_id, task_id, topic, status, message_count, started_at, created_at, updated_at)
      VALUES (?, ?, ?, 'Test', 'active', 0, ?, ?, ?)`,
      `session-${id}`,
      `ws-${id}`,
      id,
      old,
      old,
      old
    );
    sql.exec(
      `INSERT INTO workspace_activity (workspace_id, session_id, last_message_at, last_terminal_activity_at, created_at)
      VALUES (?, ?, ?, 0, ?)`,
      `ws-${id}`,
      `session-${id}`,
      old,
      old
    );
    sql.exec(
      `INSERT INTO acp_sessions (id, workspace_id, chat_session_id, status, agent_type, created_at, updated_at)
      VALUES (?, ?, ?, 'running', 'codex', ?, ?)`,
      `acp-${id}`,
      `ws-${id}`,
      `session-${id}`,
      old,
      old
    );
  }
  async function message(
    role: string,
    content: string,
    metadata: unknown = null,
    origin: string | null = null,
    id = crypto.randomUUID()
  ) {
    return persistMessageBatchWithSideEffects(sql, env, hooks, 'session-1', [
      {
        messageId: id,
        role,
        content,
        toolMetadata: metadata ? JSON.stringify(metadata) : null,
        timestamp: new Date().toISOString(),
        origin,
      },
    ]);
  }
  async function tick() {
    return processReconciliationCandidates(sql, env, hooks.broadcastEvent);
  }
  async function exhaust() {
    for (let i = 0; i < 3; i++) {
      await tick();
      await message('assistant', 'I will continue shortly.');
      vi.setSystemTime(Date.now() + IDLE);
    }
    await tick();
  }

  it('pauses after three unsuccessful check-ins, survives a new SQL adapter, and never rearms', async () => {
    await exhaust();
    expect(boundary.send).toHaveBeenCalledTimes(3);
    expect(boundary.ai).toHaveBeenCalledTimes(1);
    expect(readReconciliationEpisode(sql, 'session-1')).toMatchObject({
      attempts: 3,
      paused: true,
    });
    sql = createSqlStorage(db); // same persistent DB, no in-memory episode state
    for (let i = 0; i < 10; i++) {
      vi.setSystemTime(Date.now() + IDLE);
      await tick();
    }
    expect(boundary.send).toHaveBeenCalledTimes(3);
    expect(boundary.ai).toHaveBeenCalledTimes(1);
    expect(computeReconciliationAlarmTime(sql, env)).toBeNull();
    expect(sql.exec("SELECT * FROM chat_messages WHERE role = 'system'").toArray()).toHaveLength(1);
    expect(sql.exec('SELECT status FROM chat_sessions').toArray()[0]?.status).toBe('active');
  });

  it('pauses the plain-text unsupported-model error emitted by the current Codex runtime', async () => {
    await message(
      'assistant',
      'Warning: Model metadata for `sam-loop-invalid-model` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.\n\n'
    );
    await message(
      'assistant',
      "The 'sam-loop-invalid-model' model is not supported when using Codex with a ChatGPT account.\n\n"
    );
    expect(readReconciliationEpisode(sql, 'session-1')).toMatchObject({
      paused: true,
      attempts: 0,
    });
    expect(await getReconciliationCandidates(sql, env)).toEqual([]);
    expect(boundary.send).not.toHaveBeenCalled();
  });

  it('stops a known permanent error before even the first check-in', async () => {
    await message('assistant', permanent);
    expect(readReconciliationEpisode(sql, 'session-1')?.paused).toBe(true);
    vi.setSystemTime(Date.now() + IDLE);
    await tick();
    expect(boundary.send).not.toHaveBeenCalled();
    expect(boundary.ai).not.toHaveBeenCalled();
    expect(readReconciliationEpisode(sql, 'session-1')?.paused).toBe(true);
  });

  it('pauses immediately when the unsupported-model response arrives during delivery', async () => {
    boundary.send.mockImplementationOnce(async (_node, _workspace, acp, ...args) => {
      await message('assistant', permanent);
      return acceptedPromptResponse(acp, args[4]?.deliveryId ?? '', 'runtime-1', Date.now());
    });
    await tick();
    expect(readReconciliationEpisode(sql, 'session-1')?.paused).toBe(true);
    expect(
      sql
        .exec(
          "SELECT * FROM session_attention_markers WHERE kind = 'reconciliation_checkin' AND resolved_at IS NULL"
        )
        .toArray()
    ).toHaveLength(0);
    vi.setSystemTime(Date.now() + IDLE);
    await tick();
    expect(boundary.send).toHaveBeenCalledTimes(1);
  });

  it.each(['uncertain', 'still_working', 'unavailable'])(
    'keeps the hard budget when Clef says %s',
    async (verdict) => {
      if (verdict === 'unavailable') boundary.ai.mockRejectedValue(new Error('offline'));
      else
        boundary.ai.mockResolvedValue({
          answers: { stall_status: { value: verdict, probabilities: { [verdict]: 0.99 } } },
        });
      await exhaust();
      vi.setSystemTime(Date.now() + IDLE);
      await tick();
      expect(boundary.send).toHaveBeenCalledTimes(3);
      expect(readReconciliationEpisode(sql, 'session-1')?.paused).toBe(true);
    }
  );

  it('resets on a real human retry, not a system prompt or assistant promise', async () => {
    await exhaust();
    await message('user', 'automated wake', null, 'system');
    await message('assistant', 'I will try again');
    expect(readReconciliationEpisode(sql, 'session-1')?.paused).toBe(true);
    await persistMessageWithSideEffects(
      sql,
      env,
      hooks,
      'session-1',
      'user',
      'Fixed the runtime; try now',
      null
    );
    vi.setSystemTime(Date.now() + IDLE);
    await tick();
    expect(boundary.send).toHaveBeenCalledTimes(4);
    expect(readReconciliationEpisode(sql, 'session-1')).toMatchObject({
      attempts: 1,
      paused: false,
    });
  });

  it('counts successful tool progress once and ignores failed tools and duplicate callbacks', async () => {
    await tick();
    await message('tool', 'failed', { toolCallId: 'fail-1', status: 'failed' });
    expect(readReconciliationEpisode(sql, 'session-1')?.attempts).toBe(1);
    const id = crypto.randomUUID();
    await message('tool', 'ok', { toolCallId: 'tool-1', status: 'completed' }, null, id);
    expect(readReconciliationEpisode(sql, 'session-1')?.attempts).toBe(0);
    const episode = ensureReconciliationEpisode(sql, 'session-1');
    writeReconciliationEpisode(sql, 'session-1', { ...episode, attempts: 2 });
    await message('tool', 'ok', { toolCallId: 'tool-1', status: 'completed' }, null, id);
    await message('tool', 'ok', { toolCallId: 'tool-1', status: 'completed' });
    expect(readReconciliationEpisode(sql, 'session-1')?.attempts).toBe(2);
  });

  it('does not apply a late classifier result after human input', async () => {
    let finish!: (value: unknown) => void;
    boundary.ai.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const episode = ensureReconciliationEpisode(sql, 'session-1');
    writeReconciliationEpisode(sql, 'session-1', { ...episode, attempts: 3 });
    const pending = tick();
    await vi.waitFor(() => expect(boundary.ai).toHaveBeenCalledTimes(1));
    await message('user', 'continue');
    finish({ answers: { stall_status: { value: 'stalled', probabilities: { stalled: 1 } } } });
    await pending;
    expect(readReconciliationEpisode(sql, 'session-1')).toMatchObject({
      attempts: 0,
      paused: false,
    });
    expect(
      sql
        .exec(
          "SELECT * FROM session_attention_markers WHERE source = 'reconciliation_loop' AND resolved_at IS NULL"
        )
        .toArray()
    ).toHaveLength(0);
  });

  it('uses the configured limit and pauses when the classifier is disabled', async () => {
    Object.assign(env, {
      TASK_RECONCILIATION_MAX_CHECKINS: '1',
      STALLED_TASK_CLASSIFIER_ENABLED: 'false',
    });
    await tick();
    await message('assistant', 'No progress');
    vi.setSystemTime(Date.now() + IDLE);
    await tick();
    expect(boundary.send).toHaveBeenCalledTimes(1);
    expect(boundary.ai).not.toHaveBeenCalled();
    expect(readReconciliationEpisode(sql, 'session-1')?.paused).toBe(true);
  });

  it('bounds a hung classifier and does not call it again after timeout', async () => {
    Object.assign(env, {
      TASK_RECONCILIATION_MAX_CHECKINS: '1',
      STALLED_TASK_CLASSIFIER_TIMEOUT_MS: '10',
    });
    boundary.ai.mockImplementation(() => new Promise(() => {}));
    await tick();
    await message('assistant', 'No progress');
    vi.setSystemTime(Date.now() + IDLE);
    const pending = tick();
    await vi.advanceTimersByTimeAsync(20);
    await pending;
    await tick();
    expect(boundary.send).toHaveBeenCalledTimes(1);
    expect(boundary.ai).toHaveBeenCalledTimes(1);
    expect(readReconciliationEpisode(sql, 'session-1')?.paused).toBe(true);
  });

  it('does not classify assistant prose quoting an unsupported-model error as permanent', async () => {
    await message('assistant', `I found this error in the previous session: ${permanent}`);
    vi.setSystemTime(Date.now() + IDLE);
    await tick();
    expect(boundary.send).toHaveBeenCalledTimes(1);
    expect(readReconciliationEpisode(sql, 'session-1')?.paused).toBe(false);
  });

  it('rejects nonconsecutive completed-tool replay across a restart', async () => {
    await tick();
    await message('tool', 'ok A', { toolCallId: 'A', status: 'completed' });
    writeReconciliationEpisode(sql, 'session-1', {
      ...ensureReconciliationEpisode(sql, 'session-1'),
      attempts: 1,
    });
    await message('tool', 'ok B', { toolCallId: 'B', status: 'completed' });
    const episode = ensureReconciliationEpisode(sql, 'session-1');
    expect(episode.lastToolCallId).toBe('B');
    writeReconciliationEpisode(sql, 'session-1', { ...episode, attempts: 3, paused: true });
    sql = createSqlStorage(db);
    await persistMessageBatchWithSideEffects(sql, env, hooks, 'session-1', [
      {
        messageId: 'replay-A',
        role: 'tool',
        content: 'replayed A',
        toolMetadata: JSON.stringify({ toolCallId: 'A', status: 'completed' }),
        timestamp: new Date().toISOString(),
        sequence: -1,
      },
    ]);
    expect(readReconciliationEpisode(sql, 'session-1')).toMatchObject({
      attempts: 3,
      paused: true,
    });
  });

  it('retains the new attention marker when a human retry and permanent error arrive together', async () => {
    await exhaust();
    await persistMessageBatchWithSideEffects(sql, env, hooks, 'session-1', [
      {
        messageId: 'human-retry',
        role: 'user',
        content: 'retry now',
        toolMetadata: null,
        timestamp: new Date().toISOString(),
      },
      {
        messageId: 'runtime-error',
        role: 'assistant',
        content: permanent,
        toolMetadata: null,
        timestamp: new Date().toISOString(),
      },
    ]);
    expect(readReconciliationEpisode(sql, 'session-1')?.paused).toBe(true);
    expect(
      sql
        .exec(
          "SELECT * FROM session_attention_markers WHERE source = 'reconciliation_loop' AND resolved_at IS NULL"
        )
        .toArray()
    ).toHaveLength(1);
  });

  it('redacts opaque Authorization, Basic, and standalone Bearer credentials before Clef', async () => {
    const secrets = ['opaqueCanaryOne123', 'opaqueCanaryTwo456', 'opaqueCanaryThree789'];
    await tick();
    await message(
      'assistant',
      `Authorization: Bearer ${secrets[0]}\nAuthorization: Basic ${secrets[1]}\nBearer ${secrets[2]}`
    );
    const episode = ensureReconciliationEpisode(sql, 'session-1');
    writeReconciliationEpisode(sql, 'session-1', { ...episode, attempts: 3 });
    vi.setSystemTime(Date.now() + IDLE);
    await tick();
    const request = JSON.stringify(boundary.ai.mock.calls[0]);
    for (const secret of secrets) expect(request).not.toContain(secret);
    expect(request).toContain('[REDACTED_AUTH]');
  });

  it('reaches other work behind a full page of paused candidates', async () => {
    for (let i = 1; i <= 6; i++) {
      if (i !== 1) seed(String(i));
      const episode = ensureReconciliationEpisode(sql, `session-${i}`);
      writeReconciliationEpisode(sql, `session-${i}`, { ...episode, attempts: 3, paused: true });
    }
    seed('7');
    expect((await getReconciliationCandidates(sql, env)).map((c) => c.taskId)).toEqual(['7']);
  });
});
