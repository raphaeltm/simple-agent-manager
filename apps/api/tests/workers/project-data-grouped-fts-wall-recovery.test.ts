/**
 * Worker-runtime coverage for operator grouped/FTS wall recovery.
 *
 * Real SQLite-backed Durable Objects and real FTS5: the guarantees under test are
 * SQL- and FTS-level (candidate predicates, external-content index consistency,
 * transaction rollback), which a mocked `sql` cannot observe (rule 28). The
 * Workers pool does not enforce Cloudflare's 10 GiB per-object cap, so the
 * at-cap behaviour itself is proven only in production; these tests pin the
 * delete-first transaction shape and every candidate/budget guard.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import {
  type GroupedFtsWallRecoveryInput,
  runGroupedFtsWallRecovery,
} from '../../src/durable-objects/project-data/grouped-fts-wall-recovery';
import { resolveStorageSafetyConfig } from '../../src/durable-objects/project-data/storage-safety';
import type { Env as WorkerEnv } from '../../src/env';
import * as projectDataService from '../../src/services/project-data';
import { seedInstallation, seedProject, seedUser } from './helpers/seed-d1';
import type { ProjectDataTestDouble } from './support/expected-error-doubles';

const testEnv = env as unknown as WorkerEnv;
const OWNER = 'wall-recovery-owner';
const INSTALLATION = 'wall-recovery-installation';
const DAY_MS = 24 * 60 * 60 * 1000;

function getStub(projectId: string): DurableObjectStub<ProjectDataTestDouble> {
  return env.PROJECT_DATA.get(
    env.PROJECT_DATA.idFromName(projectId)
  ) as DurableObjectStub<ProjectDataTestDouble>;
}

async function seedProjectGraph(projectId: string): Promise<void> {
  await seedUser(OWNER);
  await seedInstallation(INSTALLATION, OWNER);
  await seedProject(projectId, OWNER, INSTALLATION, { name: `Wall recovery ${projectId}` });
}

function uniqueToken(label: string): string {
  return `${label}${crypto.randomUUID().replace(/-/g, '')}`;
}

type SeedSession = {
  topic: string;
  token: string;
  /** Assistant/user turns; each assistant message becomes its own grouped row. */
  turns: number;
  /** 'stop' is terminal; 'sleep' materializes the index but stays non-terminal. */
  end: 'stop' | 'sleep' | 'none';
  ageDays: number;
};

/**
 * Builds sessions through the real persistence + stop path so grouped rows and
 * FTS entries are produced by production materialization, not hand-inserted.
 */
async function seedSessions(
  stub: DurableObjectStub<ProjectDataTestDouble>,
  sessions: SeedSession[]
): Promise<string[]> {
  return runInDurableObject(stub, async (instance, state) => {
    const ids: string[] = [];
    for (const spec of sessions) {
      const sessionId = await instance.createSession(null, spec.topic);
      for (let i = 0; i < spec.turns; i++) {
        await instance.persistMessage(sessionId, 'user', `question ${i} ${spec.token}`, null, null);
        await instance.persistMessage(
          sessionId,
          'assistant',
          `answer ${i} mentions ${spec.token} ${'x'.repeat(200)}`,
          null,
          null
        );
      }
      if (spec.end === 'stop') await instance.stopSession(sessionId);
      if (spec.end === 'sleep') await instance.sleepSession(sessionId);
      state.storage.sql.exec(
        'UPDATE chat_sessions SET updated_at = ? WHERE id = ?',
        Date.now() - spec.ageDays * DAY_MS,
        sessionId
      );
      ids.push(sessionId);
    }
    return ids;
  });
}

type SessionSnapshot = {
  groupedRows: number;
  ftsMatches: number;
  messageDigest: string;
  searchIndexState: string | null;
  materializedAt: number | null;
};

async function snapshotSession(
  stub: DurableObjectStub<ProjectDataTestDouble>,
  sessionId: string,
  token: string
): Promise<SessionSnapshot> {
  return runInDurableObject(stub, async (_instance, state) => {
    const sql = state.storage.sql;
    const grouped = sql
      .exec('SELECT COUNT(*) AS count FROM chat_messages_grouped WHERE session_id = ?', sessionId)
      .one() as { count: number };
    // A MATCH reads the FTS index itself; joining the external-content table by
    // rowid would read the content table and could not see stale index entries.
    const fts = sql
      .exec(
        'SELECT COUNT(*) AS count FROM chat_messages_grouped_fts WHERE chat_messages_grouped_fts MATCH ?',
        token
      )
      .one() as { count: number };
    const contents = sql
      .exec('SELECT id, content FROM chat_messages WHERE session_id = ? ORDER BY id', sessionId)
      .toArray()
      .map((row) => `${String(row.id)}:${String(row.content)}`)
      .join('\n');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(contents));
    const session = sql
      .exec('SELECT search_index_state, materialized_at FROM chat_sessions WHERE id = ?', sessionId)
      .one() as { search_index_state: string | null; materialized_at: number | null };
    return {
      groupedRows: grouped.count,
      ftsMatches: fts.count,
      messageDigest: Buffer.from(digest).toString('hex'),
      searchIndexState: session.search_index_state,
      materializedAt: session.materialized_at,
    };
  });
}

/** FTS5's own consistency check between the external-content table and the index. */
async function assertFtsIntegrity(stub: DurableObjectStub<ProjectDataTestDouble>): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql.exec(
      `INSERT INTO chat_messages_grouped_fts(chat_messages_grouped_fts) VALUES('integrity-check')`
    );
  });
}

const GENEROUS = {
  maxRows: 10_000,
  maxBytes: 64 * 1024 * 1024,
  maxSessions: 50,
  wallTimeMs: 20_000,
} as const;

describe('ProjectData grouped FTS wall recovery', () => {
  it('prunes old terminal sessions largest-first, leaves message text and other sessions intact', async () => {
    const projectId = `wall-recovery-${crypto.randomUUID()}`;
    await seedProjectGraph(projectId);
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);

    const tokens = {
      large: uniqueToken('largeold'),
      small: uniqueToken('smallold'),
      active: uniqueToken('sleepingold'),
      recent: uniqueToken('recentstop'),
    };
    const [large, small, active, recent] = await seedSessions(stub, [
      { topic: 'large old', token: tokens.large, turns: 6, end: 'stop', ageDays: 30 },
      { topic: 'small old', token: tokens.small, turns: 2, end: 'stop', ageDays: 30 },
      { topic: 'sleeping old', token: tokens.active, turns: 2, end: 'sleep', ageDays: 30 },
      { topic: 'recent stop', token: tokens.recent, turns: 2, end: 'stop', ageDays: 1 },
    ]);
    const before = {
      large: await snapshotSession(stub, large!, tokens.large),
      small: await snapshotSession(stub, small!, tokens.small),
      active: await snapshotSession(stub, active!, tokens.active),
      recent: await snapshotSession(stub, recent!, tokens.recent),
    };
    expect(before.large.groupedRows).toBeGreaterThan(0);
    expect(before.large.ftsMatches).toBeGreaterThan(0);
    expect(before.small.groupedRows).toBeGreaterThan(0);
    expect(before.recent.groupedRows).toBeGreaterThan(0);
    // The non-terminal control must hold an index, or it cannot test the status guard.
    expect(before.active.groupedRows).toBeGreaterThan(0);

    // maxSessions = 1: ranking decides which old session goes first.
    const first = await projectDataService.runProjectDataGroupedFtsWallRecovery(
      testEnv,
      projectId,
      { reason: 'test: largest first', dryRun: false, ...GENEROUS, maxSessions: 1 }
    );
    expect(first.stopReason).toBe('session_budget');
    expect(first.sessions.map((s) => s.sessionId)).toEqual([large]);
    expect(first.sessions[0]?.drained).toBe(true);
    expect(first.groupedRowsDeleted).toBe(before.large.groupedRows);
    expect(first.afterBytes).toBeLessThanOrEqual(first.beforeBytes);

    const second = await projectDataService.runProjectDataGroupedFtsWallRecovery(
      testEnv,
      projectId,
      { reason: 'test: drain the rest', dryRun: false, ...GENEROUS }
    );
    expect(second.stopReason).toBe('candidates_exhausted');
    expect(second.sessions.map((s) => s.sessionId)).toEqual([small]);

    const after = {
      large: await snapshotSession(stub, large!, tokens.large),
      small: await snapshotSession(stub, small!, tokens.small),
      active: await snapshotSession(stub, active!, tokens.active),
      recent: await snapshotSession(stub, recent!, tokens.recent),
    };
    for (const pruned of [after.large, after.small]) {
      expect(pruned.groupedRows).toBe(0);
      expect(pruned.ftsMatches).toBe(0);
      expect(pruned.searchIndexState).toBe('grouped_fts_pruned');
      expect(pruned.materializedAt).toBeNull();
    }
    // Message text is byte-identical everywhere.
    expect(after.large.messageDigest).toBe(before.large.messageDigest);
    expect(after.small.messageDigest).toBe(before.small.messageDigest);
    // Sleeping (not terminal), and too recent: untouched controls.
    expect(after.active).toEqual(before.active);
    expect(after.recent).toEqual(before.recent);

    await assertFtsIntegrity(stub);

    // Search still finds the pruned session through the raw-message fallback.
    const found = await runInDurableObject(stub, async (instance) =>
      instance.searchMessages(tokens.large, null, null, 5)
    );
    expect(found.some((r: { sessionId: string }) => r.sessionId === large)).toBe(true);

    // Materialization must not re-index a pruned session.
    await runInDurableObject(stub, async (instance) => {
      await instance.stopSession(large!);
    });
    expect((await snapshotSession(stub, large!, tokens.large)).groupedRows).toBe(0);
  });

  it('dry run reports the prunable stock and writes nothing', async () => {
    const projectId = `wall-recovery-dry-${crypto.randomUUID()}`;
    await seedProjectGraph(projectId);
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const token = uniqueToken('dryrun');
    const [sessionId] = await seedSessions(stub, [
      { topic: 'dry', token, turns: 3, end: 'stop', ageDays: 30 },
    ]);
    const before = await snapshotSession(stub, sessionId!, token);

    const result = await projectDataService.runProjectDataGroupedFtsWallRecovery(
      testEnv,
      projectId,
      { reason: 'test: dry run', dryRun: true, ...GENEROUS }
    );

    expect(result.dryRun).toBe(true);
    expect(result.transactions).toBe(0);
    expect(result.ftsEntriesDeleted).toBe(0);
    expect(result.groupedRowsDeleted).toBe(before.groupedRows);
    expect(result.contentBytes).toBeGreaterThan(0);
    expect(result.afterBytes).toBe(result.beforeBytes);
    expect(await snapshotSession(stub, sessionId!, token)).toEqual(before);
  });

  it('excludes a session with an archive source intent', async () => {
    const projectId = `wall-recovery-intent-${crypto.randomUUID()}`;
    await seedProjectGraph(projectId);
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const tokens = { fenced: uniqueToken('fenced'), free: uniqueToken('free') };
    const [fenced, free] = await seedSessions(stub, [
      { topic: 'fenced', token: tokens.fenced, turns: 2, end: 'stop', ageDays: 30 },
      { topic: 'free', token: tokens.free, turns: 2, end: 'stop', ageDays: 30 },
    ]);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO project_data_archive_source_intents (
           session_id, project_id, migration_id, source_owner_name, target_owner_name,
           target_generation, source_intent_token, state, terminal_version_sha256,
           message_count, prepared_at, created_at, updated_at
         ) VALUES (?, ?, 'mig-1', ?, 'target', 1, 'token', 'copying', 'sha', 0, 1, 1, 1)`,
        fenced!,
        projectId,
        projectId
      );
    });
    const fencedBefore = await snapshotSession(stub, fenced!, tokens.fenced);

    const result = await projectDataService.runProjectDataGroupedFtsWallRecovery(
      testEnv,
      projectId,
      { reason: 'test: intent fence', dryRun: false, ...GENEROUS }
    );

    expect(result.sessions.map((s) => s.sessionId)).toEqual([free]);
    expect(await snapshotSession(stub, fenced!, tokens.fenced)).toEqual(fencedBefore);
    expect((await snapshotSession(stub, free!, tokens.free)).groupedRows).toBe(0);
  });

  it('resumes a partially pruned session across calls under a row budget', async () => {
    const projectId = `wall-recovery-resume-${crypto.randomUUID()}`;
    await seedProjectGraph(projectId);
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const token = uniqueToken('resume');
    const [sessionId] = await seedSessions(stub, [
      { topic: 'resume', token, turns: 5, end: 'stop', ageDays: 30 },
    ]);
    const before = await snapshotSession(stub, sessionId!, token);
    expect(before.groupedRows).toBeGreaterThan(2);

    const partial = await projectDataService.runProjectDataGroupedFtsWallRecovery(
      testEnv,
      projectId,
      { reason: 'test: partial', dryRun: false, ...GENEROUS, maxRows: 2 }
    );
    expect(partial.stopReason).toBe('row_budget');
    expect(partial.groupedRowsDeleted).toBe(2);
    expect(partial.sessions[0]?.drained).toBe(false);
    const mid = await snapshotSession(stub, sessionId!, token);
    expect(mid.groupedRows).toBe(before.groupedRows - 2);
    // Marked pruned from the first page, so search never trusts a half-deleted index.
    expect(mid.searchIndexState).toBe('grouped_fts_pruned');
    await assertFtsIntegrity(stub);

    const rest = await projectDataService.runProjectDataGroupedFtsWallRecovery(testEnv, projectId, {
      reason: 'test: rest',
      dryRun: false,
      ...GENEROUS,
    });
    expect(rest.sessions[0]?.drained).toBe(true);
    expect((await snapshotSession(stub, sessionId!, token)).groupedRows).toBe(0);
    await assertFtsIntegrity(stub);
  });

  it('stops on the byte budget without deleting a row that does not fit', async () => {
    const projectId = `wall-recovery-bytes-${crypto.randomUUID()}`;
    await seedProjectGraph(projectId);
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const token = uniqueToken('bytes');
    const [sessionId] = await seedSessions(stub, [
      { topic: 'bytes', token, turns: 2, end: 'stop', ageDays: 30 },
    ]);
    const before = await snapshotSession(stub, sessionId!, token);

    const result = await projectDataService.runProjectDataGroupedFtsWallRecovery(
      testEnv,
      projectId,
      { reason: 'test: byte budget', dryRun: false, ...GENEROUS, maxBytes: 1 }
    );

    expect(result.stopReason).toBe('byte_budget');
    expect(result.groupedRowsDeleted).toBe(0);
    expect(await snapshotSession(stub, sessionId!, token)).toEqual(before);
  });

  it('touches only the addressed project', async () => {
    const projectA = `wall-recovery-a-${crypto.randomUUID()}`;
    const projectB = `wall-recovery-b-${crypto.randomUUID()}`;
    await seedProjectGraph(projectA);
    await seedProjectGraph(projectB);
    const stubA = getStub(projectA);
    const stubB = getStub(projectB);
    await stubA.ensureProjectId(projectA);
    await stubB.ensureProjectId(projectB);
    const tokenA = uniqueToken('tenanta');
    const tokenB = uniqueToken('tenantb');
    const [sessionA] = await seedSessions(stubA, [
      { topic: 'a', token: tokenA, turns: 2, end: 'stop', ageDays: 30 },
    ]);
    const [sessionB] = await seedSessions(stubB, [
      { topic: 'b', token: tokenB, turns: 2, end: 'stop', ageDays: 30 },
    ]);
    const beforeB = await snapshotSession(stubB, sessionB!, tokenB);

    await projectDataService.runProjectDataGroupedFtsWallRecovery(testEnv, projectA, {
      reason: 'test: tenant scope',
      dryRun: false,
      ...GENEROUS,
    });

    expect((await snapshotSession(stubA, sessionA!, tokenA)).groupedRows).toBe(0);
    expect(await snapshotSession(stubB, sessionB!, tokenB)).toEqual(beforeB);
  });

  it('rolls back the whole page when the FTS delete fails mid-transaction', async () => {
    const projectId = `wall-recovery-rollback-${crypto.randomUUID()}`;
    await seedProjectGraph(projectId);
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const token = uniqueToken('rollback');
    const [sessionId] = await seedSessions(stub, [
      { topic: 'rollback', token, turns: 3, end: 'stop', ageDays: 30 },
    ]);
    const before = await snapshotSession(stub, sessionId!, token);

    const result = await runInDurableObject(stub, async (_instance, state) => {
      const real = state.storage.sql;
      let ftsDeletes = 0;
      // Fail the second FTS delete: the grouped DELETE and the first FTS delete have
      // already run inside the transaction, so only a real rollback restores them.
      const failing = new Proxy(real, {
        get(target, prop) {
          if (prop === 'exec') {
            return (query: string, ...bindings: unknown[]) => {
              if (query.includes(`VALUES('delete'`) && ++ftsDeletes === 2) {
                throw new Error('injected FTS failure');
              }
              return target.exec(query, ...bindings);
            };
          }
          // Native getters (`databaseSize`) need the real object as `this`.
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const input: GroupedFtsWallRecoveryInput = {
        reason: 'test: rollback',
        dryRun: false,
        ...GENEROUS,
        transactionRows: 500,
        transactionBytes: 8 * 1024 * 1024,
      };
      return runGroupedFtsWallRecovery(
        failing,
        projectId,
        input,
        resolveStorageSafetyConfig(testEnv),
        {
          transactionSync: (callback) => state.storage.transactionSync(callback),
        }
      );
    });

    expect(result.stopReason).toBe('transaction_failed');
    expect(result.error).toContain('injected FTS failure');
    expect(result.transactions).toBe(0);
    expect(result.groupedRowsDeleted).toBe(0);
    expect(await snapshotSession(stub, sessionId!, token)).toEqual(before);
    await assertFtsIntegrity(stub);
  });

  it('stops at the wall-time budget before starting another page', async () => {
    const projectId = `wall-recovery-deadline-${crypto.randomUUID()}`;
    await seedProjectGraph(projectId);
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const token = uniqueToken('deadline');
    const [sessionId] = await seedSessions(stub, [
      { topic: 'deadline', token, turns: 3, end: 'stop', ageDays: 30 },
    ]);
    const before = await snapshotSession(stub, sessionId!, token);

    const result = await runInDurableObject(stub, async (_instance, state) => {
      let clock = Date.now();
      return runGroupedFtsWallRecovery(
        state.storage.sql,
        projectId,
        {
          reason: 'test: deadline',
          dryRun: false,
          ...GENEROUS,
          wallTimeMs: 10,
          transactionRows: 1,
          transactionBytes: 8 * 1024 * 1024,
        },
        resolveStorageSafetyConfig(testEnv),
        {
          transactionSync: (callback) => state.storage.transactionSync(callback),
          // Each clock read advances 6 ms: the first page fits, the second does not.
          nowMs: () => (clock += 6),
        }
      );
    });

    expect(result.stopReason).toBe('wall_time');
    expect(result.groupedRowsDeleted).toBeGreaterThan(0);
    expect(result.groupedRowsDeleted).toBeLessThan(before.groupedRows);
    await assertFtsIntegrity(stub);
  });
});
