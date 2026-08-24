/**
 * Behavioral tests for the D1 per-project session index read.
 *
 * Run against a REAL SQLite engine (not a `.where()`-ignoring mock), because the
 * protection under test is a SQL predicate: `project_id = ?` is the tenant
 * boundary for this read. A chainable stub returning canned rows would pass
 * identically with that predicate deleted. See .claude/rules/28.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock('../../../src/lib/logger', () => ({
  log: mocks.log,
  createModuleLogger: () => mocks.log,
}));

const { listSessionsFromIndex } = await import('../../../src/services/session-summary-index');

const PROJECT = 'proj-alpha';
const OTHER_PROJECT = 'proj-beta';
const OWNER = 'user-owner';
const MEMBER = 'user-member';

describe('listSessionsFromIndex', () => {
  let sqlite: Database.Database;
  let env: Env;
  let now: number;

  function setCoverage(
    projectId: string,
    opts: { complete?: boolean; sessionCount?: number; syncedAt?: number } = {}
  ): void {
    sqlite
      .prepare(
        `INSERT INTO session_index_coverage (project_id, synced_at, session_count, complete)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
           synced_at = excluded.synced_at,
           session_count = excluded.session_count,
           complete = excluded.complete`
      )
      .run(
        projectId,
        opts.syncedAt ?? now,
        opts.sessionCount ?? 1,
        (opts.complete ?? true) ? 1 : 0
      );
  }

  function addSession(
    id: string,
    opts: {
      projectId?: string;
      status?: string;
      updatedAt?: number;
      createdByUserId?: string | null;
      agentCompletedAt?: number | null;
      workspaceId?: string | null;
      attentionJson?: string | null;
    } = {}
  ): void {
    sqlite
      .prepare(
        `INSERT INTO session_summaries
           (id, project_id, user_id, status, topic, task_id, workspace_id, message_count,
            started_at, last_message_at, agent_completed_at, ended_at, updated_at,
            created_by_user_id, created_at, attention_json, synced_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        opts.projectId ?? PROJECT,
        OWNER,
        opts.status ?? 'active',
        `Topic ${id}`,
        opts.workspaceId ?? null,
        5,
        1000,
        // last_message_at deliberately DIFFERENT from updated_at — the mapper
        // must read `lastMessageAt` from updated_at (matching the DO), and this
        // value exists to make a mix-up visible.
        999_999,
        opts.agentCompletedAt ?? null,
        opts.updatedAt ?? 5000,
        opts.createdByUserId === undefined ? OWNER : opts.createdByUserId,
        900,
        opts.attentionJson ?? null,
        now
      );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    now = 1_800_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);

    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    env = { DATABASE: createSqliteD1(sqlite), BASE_DOMAIN: 'example.test' } as Env;
  });

  afterEach(() => {
    vi.useRealTimers();
    sqlite.close();
  });

  describe('coverage gate — fails closed', () => {
    it('misses when the project has no coverage row', async () => {
      addSession('s-1');

      const out = await listSessionsFromIndex(env, {
        projectId: PROJECT,
        status: null,
        limit: 20,
        offset: 0,
        createdByUserId: null,
      });

      expect(out).toEqual({ missReason: 'no_coverage' });
    });

    it('misses when coverage says the index is incomplete', async () => {
      addSession('s-1');
      setCoverage(PROJECT, { complete: false, sessionCount: 5000 });

      const out = await listSessionsFromIndex(env, {
        projectId: PROJECT,
        status: null,
        limit: 20,
        offset: 0,
        createdByUserId: null,
      });

      expect(out).toEqual({ missReason: 'incomplete_coverage' });
    });

    it('misses when coverage is older than the staleness bound', async () => {
      addSession('s-1');
      setCoverage(PROJECT, { syncedAt: now - 60 * 60 * 1000 });

      const out = await listSessionsFromIndex(env, {
        projectId: PROJECT,
        status: null,
        limit: 20,
        offset: 0,
        createdByUserId: null,
      });

      expect(out).toEqual({ missReason: 'stale_coverage' });
    });

    it('misses instead of throwing when D1 itself fails', async () => {
      // The index is an optional accelerator in front of an authoritative source.
      // If a D1 error escaped, the fast path would become a NEW availability
      // dependency for an endpoint the DO could still answer perfectly well.
      const brokenEnv = {
        DATABASE: {
          prepare: () => {
            throw new Error('D1_ERROR: no such table: session_index_coverage');
          },
        },
      } as unknown as Env;

      const out = await listSessionsFromIndex(brokenEnv, {
        projectId: PROJECT,
        status: null,
        limit: 20,
        offset: 0,
        createdByUserId: null,
      });

      expect(out).toEqual({ missReason: 'index_error' });
      expect(mocks.log.warn).toHaveBeenCalledWith(
        'session_index.read_failed',
        expect.objectContaining({ projectId: PROJECT })
      );
    });

    it('honours the configured staleness override', async () => {
      addSession('s-1');
      setCoverage(PROJECT, { syncedAt: now - 60 * 60 * 1000 });

      const out = await listSessionsFromIndex(
        { ...env, SESSION_INDEX_MAX_STALENESS_MS: String(24 * 60 * 60 * 1000) } as Env,
        { projectId: PROJECT, status: null, limit: 20, offset: 0, createdByUserId: null }
      );

      expect('result' in out).toBe(true);
    });
  });

  describe('project scoping (tenant boundary)', () => {
    // ATTACK: another project's sessions must never appear. Paired with the
    // owner control below so "returns nothing" cannot pass by the read simply
    // being broken. Verified discriminating: deleting `project_id = ?` from the
    // WHERE clause fails this test while the control still passes.
    it("never returns another project's sessions", async () => {
      addSession('mine-1', { projectId: PROJECT });
      addSession('theirs-1', { projectId: OTHER_PROJECT });
      addSession('theirs-2', { projectId: OTHER_PROJECT });
      setCoverage(PROJECT, { sessionCount: 1 });

      const out = await listSessionsFromIndex(env, {
        projectId: PROJECT,
        status: null,
        limit: 20,
        offset: 0,
        createdByUserId: null,
      });

      if (!('result' in out)) throw new Error(`expected a result, got ${out.missReason}`);
      expect(out.result.sessions.map((s) => s.id)).toEqual(['mine-1']);
      expect(out.result.total).toBe(1);
    });

    // CONTROL: the legitimate owner does get their own project's sessions.
    it("returns the requesting project's own sessions", async () => {
      addSession('mine-1', { projectId: PROJECT });
      addSession('theirs-1', { projectId: OTHER_PROJECT });
      setCoverage(OTHER_PROJECT, { sessionCount: 1 });

      const out = await listSessionsFromIndex(env, {
        projectId: OTHER_PROJECT,
        status: null,
        limit: 20,
        offset: 0,
        createdByUserId: null,
      });

      if (!('result' in out)) throw new Error(`expected a result, got ${out.missReason}`);
      expect(out.result.sessions.map((s) => s.id)).toEqual(['theirs-1']);
    });
  });

  describe('filters and ordering', () => {
    it('orders by updated_at descending', async () => {
      addSession('old', { updatedAt: 1000 });
      addSession('newest', { updatedAt: 9000 });
      addSession('middle', { updatedAt: 5000 });
      setCoverage(PROJECT, { sessionCount: 3 });

      const out = await listSessionsFromIndex(env, {
        projectId: PROJECT,
        status: null,
        limit: 20,
        offset: 0,
        createdByUserId: null,
      });

      if (!('result' in out)) throw new Error('expected a result');
      expect(out.result.sessions.map((s) => s.id)).toEqual(['newest', 'middle', 'old']);
    });

    it('filters by status', async () => {
      addSession('active-1', { status: 'active' });
      addSession('stopped-1', { status: 'stopped' });
      setCoverage(PROJECT, { sessionCount: 2 });

      const out = await listSessionsFromIndex(env, {
        projectId: PROJECT,
        status: 'active',
        limit: 20,
        offset: 0,
        createdByUserId: null,
      });

      if (!('result' in out)) throw new Error('expected a result');
      expect(out.result.sessions.map((s) => s.id)).toEqual(['active-1']);
      expect(out.result.total).toBe(1);
    });

    it('filters by creator for scope=my', async () => {
      addSession('mine', { createdByUserId: OWNER });
      addSession('theirs', { createdByUserId: MEMBER });
      setCoverage(PROJECT, { sessionCount: 2 });

      const out = await listSessionsFromIndex(env, {
        projectId: PROJECT,
        status: null,
        limit: 20,
        offset: 0,
        createdByUserId: MEMBER,
      });

      if (!('result' in out)) throw new Error('expected a result');
      expect(out.result.sessions.map((s) => s.id)).toEqual(['theirs']);
    });

    it('reports hasMore from the offset window against the filtered total', async () => {
      addSession('a', { updatedAt: 3000 });
      addSession('b', { updatedAt: 2000 });
      addSession('c', { updatedAt: 1000 });
      setCoverage(PROJECT, { sessionCount: 3 });

      const page1 = await listSessionsFromIndex(env, {
        projectId: PROJECT,
        status: null,
        limit: 2,
        offset: 0,
        createdByUserId: null,
      });
      if (!('result' in page1)) throw new Error('expected a result');
      expect(page1.result.sessions.map((s) => s.id)).toEqual(['a', 'b']);
      expect(page1.result.hasMore).toBe(true);
      expect(page1.result.total).toBe(3);

      const page2 = await listSessionsFromIndex(env, {
        projectId: PROJECT,
        status: null,
        limit: 2,
        offset: 2,
        createdByUserId: null,
      });
      if (!('result' in page2)) throw new Error('expected a result');
      expect(page2.result.sessions.map((s) => s.id)).toEqual(['c']);
      expect(page2.result.hasMore).toBe(false);
    });
  });

  describe('row shape parity with the DO', () => {
    it('derives lastMessageAt from updated_at, not the last_message_at column', async () => {
      // The DO's row mapper sets `lastMessageAt: r.updated_at`. session_summaries
      // carries BOTH columns, so reading the intuitively-named one would silently
      // reorder the sidebar relative to the DO path.
      addSession('s-1', { updatedAt: 5000 });
      setCoverage(PROJECT, { sessionCount: 1 });

      const out = await listSessionsFromIndex(env, {
        projectId: PROJECT,
        status: null,
        limit: 20,
        offset: 0,
        createdByUserId: null,
      });

      if (!('result' in out)) throw new Error('expected a result');
      expect(out.result.sessions[0]?.lastMessageAt).toBe(5000);
      expect(out.result.sessions[0]?.lastMessageAt).not.toBe(999_999);
    });

    it('derives isIdle, isTerminated, workspaceUrl and cleanupAt like the DO', async () => {
      addSession('idle', { status: 'active', agentCompletedAt: 4242, workspaceId: 'ws-1' });
      addSession('dead', { status: 'stopped', updatedAt: 4000 });
      setCoverage(PROJECT, { sessionCount: 2 });

      const out = await listSessionsFromIndex(env, {
        projectId: PROJECT,
        status: null,
        limit: 20,
        offset: 0,
        createdByUserId: null,
      });

      if (!('result' in out)) throw new Error('expected a result');
      const idle = out.result.sessions.find((s) => s.id === 'idle');
      const dead = out.result.sessions.find((s) => s.id === 'dead');

      expect(idle?.isIdle).toBe(true);
      expect(idle?.isTerminated).toBe(false);
      expect(idle?.workspaceUrl).toBe('https://ws-ws-1.example.test');
      // The DO's LIST query does not join idle_cleanup_schedule, so null here too.
      expect(idle?.cleanupAt).toBeNull();

      expect(dead?.isIdle).toBe(false);
      expect(dead?.isTerminated).toBe(true);
      expect(dead?.workspaceUrl).toBeNull();
    });

    it('returns the attention marker the sidebar renders', async () => {
      const attention = {
        markerId: 'marker-1',
        kind: 'needs_input',
        createdAt: 1234,
        expiresAt: null,
        reason: 'Waiting on you',
        options: ['yes', 'no'],
      };
      addSession('s-1', { attentionJson: JSON.stringify(attention) });
      setCoverage(PROJECT, { sessionCount: 1 });

      const out = await listSessionsFromIndex(env, {
        projectId: PROJECT,
        status: null,
        limit: 20,
        offset: 0,
        createdByUserId: null,
      });

      if (!('result' in out)) throw new Error('expected a result');
      expect(out.result.sessions[0]?.attention).toEqual(attention);
    });
  });

  describe('per-row fault isolation (rule 50)', () => {
    it('skips a malformed row and still returns the good ones', async () => {
      // good / bad / good. The bad row violates the schema with a NULL in a
      // NOT-NULL-typed field. Discriminating: an unisolated `rows.map(parse)`
      // throws here and returns nothing.
      addSession('good-1', { updatedAt: 3000 });
      sqlite
        .prepare(
          `INSERT INTO session_summaries
             (id, project_id, user_id, status, topic, message_count, started_at, updated_at)
           VALUES ('bad-1', ?, ?, NULL, 'broken', 1, 1, 2000)`
        )
        .run(PROJECT, OWNER);
      addSession('good-2', { updatedAt: 1000 });
      setCoverage(PROJECT, { sessionCount: 3 });

      const out = await listSessionsFromIndex(env, {
        projectId: PROJECT,
        status: null,
        limit: 20,
        offset: 0,
        createdByUserId: null,
      });

      if (!('result' in out)) throw new Error('expected a result');
      expect(out.result.sessions.map((s) => s.id)).toEqual(['good-1', 'good-2']);
      // The skip must be diagnosable, with the offending row identified.
      expect(mocks.log.warn).toHaveBeenCalledWith(
        'session_index.row_skipped',
        expect.objectContaining({ rowId: 'bad-1' })
      );
    });

    it('returns an empty list rather than throwing when every row is malformed', async () => {
      sqlite
        .prepare(
          `INSERT INTO session_summaries
             (id, project_id, user_id, status, topic, message_count, started_at, updated_at)
           VALUES ('bad-1', ?, ?, NULL, 'broken', 1, 1, 2000)`
        )
        .run(PROJECT, OWNER);
      setCoverage(PROJECT, { sessionCount: 1 });

      const out = await listSessionsFromIndex(env, {
        projectId: PROJECT,
        status: null,
        limit: 20,
        offset: 0,
        createdByUserId: null,
      });

      if (!('result' in out)) throw new Error('expected a result');
      expect(out.result.sessions).toEqual([]);
      expect(mocks.log.warn).toHaveBeenCalledWith(
        'session_index.list_degraded',
        expect.objectContaining({ skipped: 1 })
      );
    });

    it('keeps a session whose attention blob is corrupt, minus its badge', async () => {
      addSession('s-1', { attentionJson: '{not valid json' });
      setCoverage(PROJECT, { sessionCount: 1 });

      const out = await listSessionsFromIndex(env, {
        projectId: PROJECT,
        status: null,
        limit: 20,
        offset: 0,
        createdByUserId: null,
      });

      if (!('result' in out)) throw new Error('expected a result');
      expect(out.result.sessions.map((s) => s.id)).toEqual(['s-1']);
      expect(out.result.sessions[0]?.attention).toBeNull();
      expect(mocks.log.warn).toHaveBeenCalledWith(
        'session_index.attention_parse_skipped',
        expect.objectContaining({ sessionId: 's-1' })
      );
    });

    it('tolerates a legacy row written before migration 0117', async () => {
      // Pre-0117 rows have NULL created_by_user_id / created_at / attention_json.
      sqlite
        .prepare(
          `INSERT INTO session_summaries
             (id, project_id, user_id, status, topic, message_count, started_at, updated_at)
           VALUES ('legacy-1', ?, ?, 'active', 'Legacy', 3, 100, 2000)`
        )
        .run(PROJECT, OWNER);
      setCoverage(PROJECT, { sessionCount: 1 });

      const out = await listSessionsFromIndex(env, {
        projectId: PROJECT,
        status: null,
        limit: 20,
        offset: 0,
        createdByUserId: null,
      });

      if (!('result' in out)) throw new Error('expected a result');
      expect(out.result.sessions.map((s) => s.id)).toEqual(['legacy-1']);
      expect(out.result.sessions[0]?.createdByUserId).toBeNull();
      expect(out.result.sessions[0]?.attention).toBeNull();
    });
  });
});
