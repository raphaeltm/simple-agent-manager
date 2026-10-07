import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runMigrations } from '../../../src/durable-objects/migrations';
import { resolveDurableExecutionConfig } from '../../../src/durable-objects/project-data/durable-execution-config';
import {
  acceptPromptDelivery,
  applyPromptDeliveryResult,
  claimDuePromptDeliveries,
  computePromptDeliveryAlarmTime,
  markPromptDeliverySubmitting,
} from '../../../src/durable-objects/project-data/prompt-delivery';
import {
  applySessionWakeReady,
  isSessionWakeReadyCurrent,
  type SessionWakeReadyInput,
} from '../../../src/durable-objects/project-data/session-wake-ready';
import type { Env } from '../../../src/env';
import { versionedPromptCapabilities } from '../../helpers/vm-prompt-delivery-fixtures';
import { createSqlStorage } from './sql-storage-test-utils';

const config = resolveDurableExecutionConfig({});
const now = 1_000_000;
const input: SessionWakeReadyInput = {
  projectId: 'project',
  chatSessionId: 'chat',
  workspaceId: 'workspace',
  agentSessionId: 'agent',
  fence: { runtime: 'vm', taskId: 'task', recoveryAttemptId: 'wake-1' },
};
const retry = {
  kind: 'retry' as const,
  reason: 'not_ready' as const,
  error: 'Session waking',
  runtimeIdentity: null,
  capabilities: null,
};

describe('wake-ready scheduling with saturated backoff', () => {
  let db: Database.Database;
  let sql: SqlStorage;
  beforeEach(() => {
    db = new Database(':memory:');
    sql = createSqlStorage(db);
    runMigrations(sql);
    sql.exec(
      `INSERT INTO chat_sessions (id, workspace_id, topic, status, message_count, started_at, created_at, updated_at)
      VALUES ('chat', 'workspace', 'Wake test', 'active', 0, ?, ?, ?)`,
      now,
      now,
      now
    );
  });
  afterEach(() => db.close());
  function enqueue(id: string, createdAt = now) {
    acceptPromptDelivery(
      sql,
      {},
      {
        deliveryId: id,
        targetSessionId: 'chat',
        displayContent: id,
        senderType: 'human',
        sourceKind: 'user_followup',
        ttlMs: config.ttlMs,
      },
      createdAt
    );
  }
  function saturated(id: string) {
    sql.exec(
      `UPDATE session_inbox SET delivery_state = 'retry_wait', delivery_attempts = ?, next_attempt_at = ? WHERE id = ?`,
      config.maxAttempts - 1,
      now + config.retryMaxMs,
      id
    );
  }
  it.each(['vm', 'cf-container'] as const)(
    'releases %s retries immediately, preserves order and suppresses duplicate wakes',
    (runtime) => {
      const ready =
        runtime === 'vm'
          ? input
          : { ...input, fence: { runtime, nodeId: 'node', runtimeIncarnationId: 'incarnation' } };
      enqueue('first');
      enqueue('second', now + 1);
      saturated('first');
      saturated('second');
      expect(claimDuePromptDeliveries(sql, config, now + 10)).toEqual([]);
      expect(applySessionWakeReady(sql, ready, now + 10)).toBe(2);
      expect(computePromptDeliveryAlarmTime(sql, config, now + 10)).toBe(
        now + 10 + config.minAlarmDelayMs
      );
      const claims = claimDuePromptDeliveries(sql, config, now + 10);
      expect(claims.map((c) => c.message.id)).toEqual(['first']);
      expect(claimDuePromptDeliveries(sql, config, now + 11)).toEqual([]);
      expect(
        markPromptDeliverySubmitting(sql, claims[0]!, versionedPromptCapabilities('runtime'))
      ).toBe(true);
      const capabilities = versionedPromptCapabilities('runtime');
      applyPromptDeliveryResult(
        sql,
        claims[0]!,
        {
          kind: 'accepted',
          acpSessionId: 'acp',
          promptEpoch: now + 11,
          runtimeIdentity: 'runtime',
          capabilities,
          receipt: null,
        },
        config,
        now + 11
      );
      const second = claimDuePromptDeliveries(sql, config, now + 11)[0]!;
      expect(second.message.id).toBe('second');
      applyPromptDeliveryResult(sql, second, { ...retry, reason: 'busy' }, config, now + 11);
      expect(applySessionWakeReady(sql, ready, now + 12)).toBe(0);
      expect(claimDuePromptDeliveries(sql, config, now + 12)).toEqual([]);
    }
  );
  it('retains readiness arriving before preparation timeout once, without releasing submitting work', () => {
    enqueue('preparing');
    const [preparing] = claimDuePromptDeliveries(sql, config, now);
    expect(applySessionWakeReady(sql, input, now + 10)).toBe(1);
    expect(applyPromptDeliveryResult(sql, preparing!, retry, config, now + 11)).toBe(true);
    const next = claimDuePromptDeliveries(sql, config, now + 12);
    expect(next.map((c) => c.message.id)).toEqual(['preparing']);
    expect(
      markPromptDeliverySubmitting(sql, preparing!, versionedPromptCapabilities('runtime'))
    ).toBe(false);
    applyPromptDeliveryResult(sql, next[0]!, retry, config, now + 13);
    expect(claimDuePromptDeliveries(sql, config, now + 14)).toEqual([]);
  });
  it('never releases a submitting claim, including after its receipt deadline', () => {
    enqueue('submitting');
    const claim = claimDuePromptDeliveries(sql, config, now)[0]!;
    markPromptDeliverySubmitting(sql, claim, versionedPromptCapabilities('runtime'));
    expect(applySessionWakeReady(sql, input, now + 10)).toBe(0);
    expect(claimDuePromptDeliveries(sql, config, now + 11)).toEqual([]);
    expect(claimDuePromptDeliveries(sql, config, now + config.receiptTimeoutMs)[0]?.mode).toBe(
      'reconcile'
    );
  });
  it('an older transient retry blocks newer same-class prompts and does not create an immediate alarm loop', () => {
    enqueue('first');
    enqueue('second');
    const first = claimDuePromptDeliveries(sql, config, now)[0]!;
    expect(claimDuePromptDeliveries(sql, config, now + 1)).toEqual([]);
    expect(computePromptDeliveryAlarmTime(sql, config, now + 1)).toBe(
      now + config.receiptTimeoutMs
    );
    applyPromptDeliveryResult(sql, first, { ...retry, reason: 'busy' }, config, now + 1);
    expect(claimDuePromptDeliveries(sql, config, now + 2)).toEqual([]);
    expect(computePromptDeliveryAlarmTime(sql, config, now + 2)).toBe(now + 1 + config.retryBaseMs);
    expect(
      claimDuePromptDeliveries(sql, config, now + 1 + config.retryBaseMs).map((c) => c.message.id)
    ).toEqual(['first']);
  });
  it('keeps independent target delivery concurrent and lets urgent queued work outrank normal retry wait', () => {
    enqueue('first');
    enqueue('urgent');
    sql.exec("UPDATE session_inbox SET message_class = 'interrupt' WHERE id = ?", 'urgent');
    saturated('first');
    sql.exec(
      `INSERT INTO chat_sessions (id, workspace_id, topic, status, message_count, started_at, created_at, updated_at)
      VALUES ('other-chat', 'other-workspace', 'Other', 'active', 0, ?, ?, ?)`,
      now,
      now,
      now
    );
    acceptPromptDelivery(
      sql,
      {},
      {
        deliveryId: 'other',
        targetSessionId: 'other-chat',
        displayContent: 'Other',
        senderType: 'human',
        sourceKind: 'user_followup',
        ttlMs: config.ttlMs,
      },
      now
    );
    expect(claimDuePromptDeliveries(sql, config, now).map((c) => c.message.id)).toEqual([
      'urgent',
      'other',
    ]);
  });
  it.each(['stopped', 'failed', 'sleeping'])('does not release a %s session', (status) => {
    enqueue('queued');
    saturated('queued');
    sql.exec('UPDATE chat_sessions SET status = ? WHERE id = ?', status, 'chat');
    expect(applySessionWakeReady(sql, input, now + 10)).toBe(0);
    expect(claimDuePromptDeliveries(sql, config, now + 10)).toEqual([]);
  });
  it('rejects obsolete workspace bindings and never retries expired/accepted/ambiguous deliveries', () => {
    enqueue('expired', now - config.ttlMs);
    enqueue('accepted');
    enqueue('ambiguous');
    sql.exec("UPDATE session_inbox SET delivery_state = 'acked' WHERE id = ?", 'accepted');
    sql.exec("UPDATE session_inbox SET delivery_state = 'ambiguous' WHERE id = ?", 'ambiguous');
    expect(applySessionWakeReady(sql, { ...input, workspaceId: 'old-workspace' }, now)).toBe(0);
    applySessionWakeReady(sql, input, now);
    expect(claimDuePromptDeliveries(sql, config, now)).toEqual([]);
  });
});

describe('wake-ready D1 authority fences', () => {
  it.each(['vm', 'cf-container'] as const)(
    'requires the current committed %s wake and fails closed on stale authority',
    async (runtime) => {
      const first = vi.fn().mockResolvedValue(null);
      const bind = vi.fn().mockReturnValue({ first });
      const prepare = vi.fn().mockReturnValue({ bind });
      const env = { DATABASE: { prepare } } as unknown as Env;
      const ready: SessionWakeReadyInput =
        runtime === 'vm'
          ? input
          : { ...input, fence: { runtime, nodeId: 'node', runtimeIncarnationId: 'incarnation' } };
      expect(await isSessionWakeReadyCurrent(env, ready)).toBe(false);
      first.mockResolvedValue({ ready: 1 });
      expect(await isSessionWakeReadyCurrent(env, ready)).toBe(true);
      expect(prepare.mock.calls[0]![0]).toContain(
        runtime === 'vm' ? 's.recovery_attempt_id = ?' : 'n.runtime_incarnation_id = ?'
      );
      expect(bind.mock.calls[0]).toEqual(
        runtime === 'vm'
          ? ['workspace', 'project', 'chat', 'agent', 'task', 'wake-1']
          : ['workspace', 'project', 'chat', 'agent', 'node', 'incarnation']
      );
      first.mockRejectedValue(new Error('D1 unavailable'));
      await expect(isSessionWakeReadyCurrent(env, ready)).rejects.toThrow('D1 unavailable');
    }
  );
});

describe('readiness against actual SQL authority', () => {
  it.each(['vm', 'cf-container'] as const)(
    'rejects stale %s attempts, stopped runtimes, replaced agents and other projects',
    async (runtime) => {
      const db = new Database(':memory:');
      try {
        db.exec(`CREATE TABLE nodes (id TEXT, runtime TEXT, status TEXT, runtime_incarnation_id TEXT);
        CREATE TABLE workspaces (id TEXT, node_id TEXT, project_id TEXT, chat_session_id TEXT, status TEXT, runtime_deletion_confirmed_at TEXT);
        CREATE TABLE agent_sessions (id TEXT, workspace_id TEXT, status TEXT);
        CREATE TABLE session_snapshots (chat_session_id TEXT, project_id TEXT, recovery_status TEXT, recovery_workspace_id TEXT, recovery_task_id TEXT, recovery_attempt_id TEXT);
        CREATE TABLE tasks (id TEXT, project_id TEXT, chat_session_id TEXT, status TEXT);
        INSERT INTO workspaces VALUES ('workspace','node','project','chat','running',NULL);
        INSERT INTO agent_sessions VALUES ('agent','workspace','running');
        INSERT INTO session_snapshots VALUES ('chat','project','restored','workspace','task','wake-1');
        INSERT INTO tasks VALUES ('task','project','chat','in_progress');`);
        db.prepare('INSERT INTO nodes VALUES (?, ?, ?, ?)').run(
          'node',
          runtime,
          'running',
          'incarnation'
        );
        const env = {
          DATABASE: {
            prepare: (query: string) => ({
              bind: (...values: unknown[]) => ({
                first: async () => db.prepare(query).get(...values) ?? null,
              }),
            }),
          },
        } as unknown as Env;
        const ready: SessionWakeReadyInput =
          runtime === 'vm'
            ? input
            : { ...input, fence: { runtime, nodeId: 'node', runtimeIncarnationId: 'incarnation' } };
        expect(await isSessionWakeReadyCurrent(env, ready)).toBe(true);
        expect(await isSessionWakeReadyCurrent(env, { ...ready, projectId: 'other-project' })).toBe(
          false
        );
        expect(
          await isSessionWakeReadyCurrent(env, { ...ready, agentSessionId: 'replaced-agent' })
        ).toBe(false);
        if (runtime === 'vm')
          db.exec("UPDATE session_snapshots SET recovery_attempt_id = 'new-wake'");
        else db.exec("UPDATE nodes SET runtime_incarnation_id = 'new-incarnation'");
        expect(await isSessionWakeReadyCurrent(env, ready)).toBe(false);
        if (runtime === 'vm')
          db.exec("UPDATE session_snapshots SET recovery_attempt_id = 'wake-1'");
        else db.exec("UPDATE nodes SET runtime_incarnation_id = 'incarnation'");
        db.exec("UPDATE nodes SET status = 'stopped'");
        expect(await isSessionWakeReadyCurrent(env, ready)).toBe(false);
        db.exec(
          "UPDATE nodes SET status = 'running'; UPDATE workspaces SET runtime_deletion_confirmed_at = 'deleted'"
        );
        expect(await isSessionWakeReadyCurrent(env, ready)).toBe(false);
      } finally {
        db.close();
      }
    }
  );
});
