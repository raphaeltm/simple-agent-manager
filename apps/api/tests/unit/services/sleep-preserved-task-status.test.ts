/**
 * The sleep-preserved terminal-status authority against a real SQL engine
 * (`.claude/rules/28`): the reaper ownership predicate must mirror the sleep
 * claimer for failed tasks, and the "sleep gave up" definition must mean the same
 * thing in TypeScript (the exhaustion release) and SQL (the reapers).
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import {
  exhaustedSessionSleepSql,
  isSessionSleepExhausted,
  type SessionSleepAttemptState,
  sleepLifecycleOwnsTerminalTaskWorkspaceSql,
} from '../../../src/services/sleep-preserved-task-status';
import { createSchemaTables } from '../../helpers/sqlite-d1';

const NOW = '2026-09-25T11:00:00.000Z';
const MAX_SLEEP_ATTEMPTS = 9;

describe('sleep-preserved task status authority', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [
      schema.nodes,
      schema.workspaces,
      schema.tasks,
      schema.agentSessions,
      schema.sessionSnapshots,
    ]);
  });

  afterEach(() => sqlite.close());

  function seedSnapshot(row: Partial<SessionSleepAttemptState>) {
    sqlite
      .prepare(
        `INSERT INTO session_snapshots
           (id, project_id, workspace_id, user_id, chat_session_id, runtime, status, degradation,
            manifest_r2_key, expires_at, sleeping_at, sleep_status, sleep_after, capture_generation,
            sleep_attempts, recovery_attempts, created_at, updated_at)
         VALUES ('snapshot-1', 'project-1', 'ws-1', 'user-1', 'chat-1', 'vm', ?, ?, 'manifest.json',
                 ?, ?, ?, ?, ?, ?, 0, ?, ?)`
      )
      .run(
        row.status ?? 'available',
        row.status === 'degraded' ? 'transcript-only' : 'none',
        NOW,
        row.sleepingAt ?? null,
        row.sleepStatus ?? null,
        row.sleepAfter ?? null,
        row.captureGeneration ?? null,
        row.sleepAttempts ?? 0,
        NOW,
        NOW
      );
  }

  describe('the given-up sleep definition', () => {
    const spent = MAX_SLEEP_ATTEMPTS;
    const rows: Array<[string, Partial<SessionSleepAttemptState>, boolean]> = [
      ['failed with its budget spent', { sleepStatus: 'failed', sleepAttempts: spent }, true],
      // Raising SESSION_SLEEP_MAX_ATTEMPTS re-arms such a row, and the sweep retries it.
      [
        'failed with budget left and no retry time',
        { sleepStatus: 'failed', sleepAttempts: 3 },
        false,
      ],
      ['terminally refused', { sleepStatus: 'terminal_failed' }, true],
      [
        'failed with a retry scheduled',
        { sleepStatus: 'failed', sleepAfter: NOW, sleepAttempts: spent },
        false,
      ],
      [
        'a degraded capture the sweep keeps retrying',
        { sleepStatus: 'failed', status: 'degraded', sleepAttempts: spent },
        false,
      ],
      [
        'a capture still in progress',
        { sleepStatus: 'failed', captureGeneration: 'g-2', sleepAttempts: spent },
        false,
      ],
      ['scheduled', { sleepStatus: 'scheduled', sleepAfter: NOW }, false],
      ['in flight', { sleepStatus: 'preparing' }, false],
      ['asleep', { sleepStatus: 'sleeping', sleepingAt: NOW }, false],
      ['never scheduled', {}, false],
    ];

    it.each(rows)('%s: TypeScript and SQL agree', (_label, row, exhausted) => {
      seedSnapshot(row);
      const sqlAnswer = sqlite
        .prepare(`SELECT ${exhaustedSessionSleepSql("'chat-1'", MAX_SLEEP_ATTEMPTS)} AS exhausted`)
        .get() as { exhausted: number };

      expect(
        isSessionSleepExhausted(
          {
            sleepingAt: row.sleepingAt ?? null,
            sleepAfter: row.sleepAfter ?? null,
            sleepStatus: row.sleepStatus ?? null,
            sleepAttempts: row.sleepAttempts ?? 0,
            status: row.status ?? 'available',
            captureGeneration: row.captureGeneration ?? null,
          },
          MAX_SLEEP_ATTEMPTS
        )
      ).toBe(exhausted);
      expect(sqlAnswer.exhausted === 1).toBe(exhausted);
    });
  });

  describe('which terminal-task workspaces the reapers must leave to the sleep lifecycle', () => {
    interface Fixture {
      taskStatus?: string;
      workspaceStatus?: string;
      chatSessionId?: string | null;
      projectId?: string | null;
      node?: { role: string; runtime: string } | null;
      agentStatus?: string | null;
      snapshot?: Partial<SessionSleepAttemptState> | null;
    }

    function owned(fixture: Fixture): boolean {
      const node = fixture.node === undefined ? { role: 'workspace', runtime: 'vm' } : fixture.node;
      if (node) {
        sqlite
          .prepare(
            `INSERT INTO nodes (id, user_id, status, node_role, runtime)
             VALUES ('node-1', 'user-1', 'running', ?, ?)`
          )
          .run(node.role, node.runtime);
      }
      sqlite
        .prepare(
          `INSERT INTO workspaces (id, node_id, project_id, user_id, chat_session_id, status)
           VALUES ('ws-1', ?, ?, 'user-1', ?, ?)`
        )
        .run(
          node ? 'node-1' : null,
          fixture.projectId === undefined ? 'project-1' : fixture.projectId,
          fixture.chatSessionId === undefined ? 'chat-1' : fixture.chatSessionId,
          fixture.workspaceStatus ?? 'running'
        );
      sqlite
        .prepare(
          `INSERT INTO tasks (id, project_id, user_id, workspace_id, status)
           VALUES ('task-1', 'project-1', 'user-1', 'ws-1', ?)`
        )
        .run(fixture.taskStatus ?? 'failed');
      if (fixture.agentStatus !== null) {
        sqlite
          .prepare(
            `INSERT INTO agent_sessions (id, workspace_id, status, created_at)
             VALUES ('agent-1', 'ws-1', ?, ?)`
          )
          .run(fixture.agentStatus ?? 'running', NOW);
      }
      if (fixture.snapshot) seedSnapshot(fixture.snapshot);
      const row = sqlite
        .prepare(
          `SELECT ${sleepLifecycleOwnsTerminalTaskWorkspaceSql('t', 'w', MAX_SLEEP_ATTEMPTS)} AS owned
             FROM tasks t JOIN workspaces w ON w.id = t.workspace_id WHERE t.id = 'task-1'`
        )
        .get() as { owned: number };
      return row.owned === 1;
    }

    it.each<[string, Fixture]>([
      ['a claimable running VM', {}],
      ['a claimable Instant container', { node: { role: 'workspace', runtime: 'cf-container' } }],
      ['a workspace in recovery', { workspaceStatus: 'recovery' }],
      ['a sleep that is scheduled', { snapshot: { sleepStatus: 'scheduled', sleepAfter: NOW } }],
      [
        'a failed attempt with a retry left',
        { snapshot: { sleepStatus: 'failed', sleepAfter: NOW } },
      ],
      [
        'a degraded capture the sweep still retries',
        { snapshot: { sleepStatus: 'failed', status: 'degraded', sleepAttempts: 9 } },
      ],
      [
        'a failed attempt re-armed by a raised budget',
        { snapshot: { sleepStatus: 'failed', sleepAttempts: 3 } },
      ],
      [
        'a runtime that already slept',
        {
          workspaceStatus: 'sleeping',
          agentStatus: 'sleeping',
          snapshot: { sleepStatus: 'sleeping', sleepingAt: NOW },
        },
      ],
    ])('keeps a failed task with %s', (_label, fixture) => {
      expect(owned(fixture)).toBe(true);
    });

    it.each<[string, Fixture]>([
      ['no chat link', { chatSessionId: null }],
      ['no project', { projectId: null }],
      ['no node', { node: null }],
      ['a deployment node', { node: { role: 'deployment', runtime: 'vm' } }],
      ['an agent session that errored', { agentStatus: 'error' }],
      ['no agent session', { agentStatus: null }],
      ['a stopped workspace', { workspaceStatus: 'stopped' }],
      ['a workspace still creating', { workspaceStatus: 'creating' }],
      ['a sleep with its budget spent', { snapshot: { sleepStatus: 'failed', sleepAttempts: 9 } }],
      ['a terminally refused sleep', { snapshot: { sleepStatus: 'terminal_failed' } }],
    ])('releases a failed task with %s to the reapers', (_label, fixture) => {
      expect(owned(fixture)).toBe(false);
    });

    it('keeps a completed task on its chat link alone (pre-existing behaviour)', () => {
      expect(
        owned({
          taskStatus: 'completed',
          node: { role: 'deployment', runtime: 'vm' },
          agentStatus: 'error',
          snapshot: { sleepStatus: 'terminal_failed' },
        })
      ).toBe(true);
    });

    it('never keeps a cancelled task', () => {
      expect(owned({ taskStatus: 'cancelled' })).toBe(false);
    });
  });
});
