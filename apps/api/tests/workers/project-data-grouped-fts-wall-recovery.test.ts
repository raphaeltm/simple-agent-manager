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

import { GROUPED_PAGE_SIZES_SQL } from '../../src/durable-objects/project-data/grouped-fts-pages';
import {
  type GroupedFtsWallRecoveryRequest,
  runGroupedFtsWallRecovery,
} from '../../src/durable-objects/project-data/grouped-fts-wall-recovery';
import { materializeSession } from '../../src/durable-objects/project-data/materialization';
import { resolveStorageSafetyConfig } from '../../src/durable-objects/project-data/storage-safety';
import type { Env as WorkerEnv } from '../../src/env';
import * as projectDataService from '../../src/services/project-data';
import {
  assertFtsIntegrity,
  createProject as createGroupedFtsProject,
  searchFinds,
  seedOldSession,
  seedSessions,
  snapshotSession,
  STORAGE_FULL,
  type Stub,
} from './helpers/grouped-fts-fixtures';

const testEnv = env as unknown as WorkerEnv;
const createProject = (label: string) => createGroupedFtsProject(label, 'wall-recovery');

const GENEROUS = {
  maxRows: 10_000,
  maxBytes: 64 * 1024 * 1024,
  maxSessions: 50,
  skipSessionIds: [] as string[],
};

/** The production path: service wrapper → DO RPC → module, with generous budgets. */
function recover(projectId: string, overrides: Partial<GroupedFtsWallRecoveryRequest> = {}) {
  return projectDataService.runProjectDataGroupedFtsWallRecovery(testEnv, projectId, {
    reason: 'test',
    dryRun: false,
    ...GENEROUS,
    ...overrides,
  });
}

/**
 * Runs the module with `sql.exec` throwing on FTS `'delete'` commands chosen by
 * `failure(attempt, deleteIndex)`: `attempt` counts attempts to delete a page's FTS
 * entries (1-based), `deleteIndex` counts deletes within that attempt (1-based).
 * Returning a message throws `new Error(message)`.
 */
async function recoverWithFtsFailures(
  stub: Stub,
  projectId: string,
  failure: (attempt: number, deleteIndex: number) => string | undefined
) {
  return runInDurableObject(stub, async (_instance, state) => {
    let attempt = 0;
    let deleteIndex = 0;
    const failing = new Proxy(state.storage.sql, {
      get(target, prop) {
        if (prop === 'exec') {
          return (query: string, ...bindings: unknown[]) => {
            if (query.includes(`VALUES('delete'`)) {
              if (deleteIndex === 0) attempt++;
              const message = failure(attempt, ++deleteIndex);
              if (message) throw new Error(message);
            } else {
              deleteIndex = 0;
            }
            return target.exec(query, ...bindings);
          };
        }
        // Native getters (`databaseSize`) need the real object as `this`.
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return runGroupedFtsWallRecovery(
      failing,
      projectId,
      {
        reason: 'test: injected FTS failure',
        dryRun: false,
        ...GENEROUS,
        transactionRows: 500,
        transactionBytes: 8 * 1024 * 1024,
      },
      resolveStorageSafetyConfig(testEnv),
      { transactionSync: (callback) => state.storage.transactionSync(callback) }
    );
  });
}

/** Storage-full on each FTS attempt listed, as Cloudflare reports it at the cap. */
function storageFullOn(...attempts: number[]) {
  return (attempt: number) => (attempts.includes(attempt) ? STORAGE_FULL : undefined);
}

describe('ProjectData grouped FTS wall recovery', () => {
  it('prunes old terminal sessions largest-first, leaves message text and other sessions intact', async () => {
    const { projectId, stub } = await createProject('order');
    const [large, small, sleeping, recent] = await seedSessions(stub, [
      { label: 'largeold', turns: 6 },
      { label: 'smallold', turns: 2 },
      { label: 'sleepingold', turns: 2, end: 'sleep' },
      { label: 'recentstop', turns: 2, ageDays: 1 },
    ]);
    expect(large!.before.groupedRows).toBeGreaterThan(0);
    expect(large!.before.ftsMatches).toBeGreaterThan(0);
    expect(small!.before.groupedRows).toBeGreaterThan(0);
    expect(recent!.before.groupedRows).toBeGreaterThan(0);
    // The non-terminal control must hold an index, or it cannot test the status guard.
    expect(sleeping!.before.groupedRows).toBeGreaterThan(0);

    // maxSessions = 1: ranking decides which old session goes first.
    const first = await recover(projectId, { maxSessions: 1 });
    expect(first.stopReason).toBe('session_budget');
    expect(first.sessions.map((s) => s.sessionId)).toEqual([large!.sessionId]);
    expect(first.sessions[0]?.drained).toBe(true);
    expect(first.groupedRowsDeleted).toBe(large!.before.groupedRows);
    expect(first.afterBytes).toBeLessThanOrEqual(first.beforeBytes);

    const second = await recover(projectId);
    expect(second.stopReason).toBe('candidates_exhausted');
    expect(second.sessions.map((s) => s.sessionId)).toEqual([small!.sessionId]);

    for (const session of [large!, small!]) {
      const after = await snapshotSession(stub, session);
      expect(after.groupedRows).toBe(0);
      expect(after.ftsMatches).toBe(0);
      expect(after.searchIndexState).toBe('grouped_fts_pruned');
      expect(after.materializedAt).toBeNull();
      // Message text is byte-identical.
      expect(after.messageDigest).toBe(session.before.messageDigest);
    }
    // Sleeping (not terminal), and too recent: untouched controls.
    for (const control of [sleeping!, recent!]) {
      expect(await snapshotSession(stub, control)).toEqual(control.before);
    }

    await assertFtsIntegrity(stub);

    // Search still finds the pruned session through the raw-message fallback.
    expect(await searchFinds(stub, large!)).toBe(true);

    // Materialization must not re-index a pruned session...
    await runInDurableObject(stub, async (_instance, state) => {
      materializeSession(state.storage.sql, large!.sessionId);
    });
    expect((await snapshotSession(stub, large!)).groupedRows).toBe(0);
    // ...and the pruned state is what stops it: the same session without it re-indexes.
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE chat_sessions SET search_index_state = NULL WHERE id = ?',
        large!.sessionId
      );
      materializeSession(state.storage.sql, large!.sessionId);
    });
    expect((await snapshotSession(stub, large!)).groupedRows).toBeGreaterThan(0);
  });

  it('dry run reports the prunable stock and writes nothing', async () => {
    const { projectId, stub } = await createProject('dry');
    const session = await seedOldSession(stub, 'dryrun');

    const result = await recover(projectId, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.transactions).toBe(0);
    expect(result.ftsEntriesDeleted).toBe(0);
    expect(result.groupedRowsDeleted).toBe(session.before.groupedRows);
    expect(result.contentBytes).toBeGreaterThan(0);
    expect(result.afterBytes).toBe(result.beforeBytes);
    expect(await snapshotSession(stub, session)).toEqual(session.before);
  });

  it('excludes a session with an archive source intent', async () => {
    const { projectId, stub } = await createProject('intent');
    const [fenced, free] = await seedSessions(stub, [
      { label: 'fenced', turns: 2 },
      { label: 'free', turns: 2 },
    ]);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO project_data_archive_source_intents (
           session_id, project_id, migration_id, source_owner_name, target_owner_name,
           target_generation, source_intent_token, state, terminal_version_sha256,
           message_count, prepared_at, created_at, updated_at
         ) VALUES (?, ?, 'mig-1', ?, 'target', 1, 'token', 'copying', 'sha', 0, 1, 1, 1)`,
        fenced!.sessionId,
        projectId,
        projectId
      );
    });

    const result = await recover(projectId);

    expect(result.sessions.map((s) => s.sessionId)).toEqual([free!.sessionId]);
    expect(await snapshotSession(stub, fenced!)).toEqual(fenced!.before);
    expect((await snapshotSession(stub, free!)).groupedRows).toBe(0);
  });

  it('resumes a partially pruned session across calls under a row budget', async () => {
    const { projectId, stub } = await createProject('resume');
    const session = await seedOldSession(stub, 'resume', 5);
    expect(session.before.groupedRows).toBeGreaterThan(2);

    const partial = await recover(projectId, { maxRows: 2 });
    expect(partial.stopReason).toBe('row_budget');
    expect(partial.groupedRowsDeleted).toBe(2);
    expect(partial.sessions[0]?.drained).toBe(false);
    const mid = await snapshotSession(stub, session);
    expect(mid.groupedRows).toBe(session.before.groupedRows - 2);
    // Marked pruned from the first page, so search never trusts a half-deleted index.
    expect(mid.searchIndexState).toBe('grouped_fts_pruned');
    await assertFtsIntegrity(stub);

    const rest = await recover(projectId);
    expect(rest.sessions[0]?.drained).toBe(true);
    expect((await snapshotSession(stub, session)).groupedRows).toBe(0);
    await assertFtsIntegrity(stub);
  });

  it('stops on the byte budget without deleting a row that does not fit', async () => {
    const { projectId, stub } = await createProject('bytes');
    const session = await seedOldSession(stub, 'bytes', 2);

    const result = await recover(projectId, { maxBytes: 1 });

    expect(result.stopReason).toBe('byte_budget');
    expect(result.groupedRowsDeleted).toBe(0);
    expect(await snapshotSession(stub, session)).toEqual(session.before);
  });

  it('touches only the addressed project', async () => {
    const a = await createProject('tenant-a');
    const b = await createProject('tenant-b');
    const sessionA = await seedOldSession(a.stub, 'tenanta', 2);
    const sessionB = await seedOldSession(b.stub, 'tenantb', 2);

    await recover(a.projectId);

    expect((await snapshotSession(a.stub, sessionA)).groupedRows).toBe(0);
    expect(await snapshotSession(b.stub, sessionB)).toEqual(sessionB.before);
  });

  it('rolls back the whole page when the FTS delete fails mid-transaction', async () => {
    const { projectId, stub } = await createProject('rollback');
    const session = await seedOldSession(stub, 'rollback');

    // Fail the second FTS delete of the atomic attempt: the grouped DELETE and the
    // first FTS delete have already run inside the transaction, so only a real
    // rollback restores them.
    const result = await recoverWithFtsFailures(stub, projectId, (attempt, deleteIndex) =>
      attempt === 1 && deleteIndex === 2 ? 'injected FTS failure' : undefined
    );

    expect(result.stopReason).toBe('transaction_failed');
    expect(result.error).toContain('injected FTS failure');
    expect(result.failedSessionId).toBe(session.sessionId);
    expect(result.transactions).toBe(0);
    expect(result.groupedRowsDeleted).toBe(0);
    expect(await snapshotSession(stub, session)).toEqual(session.before);
    await assertFtsIntegrity(stub);
  });

  it('at the cap, retries a storage-full page as delete-then-FTS and keeps the index exact', async () => {
    const { projectId, stub } = await createProject('fallback');
    const session = await seedOldSession(stub, 'fallback');

    // Only the atomic attempt fails; the separate FTS transaction fits.
    const result = await recoverWithFtsFailures(stub, projectId, storageFullOn(1));

    expect(result.error).toBeNull();
    expect(result.ftsStaleRows).toBe(0);
    expect(result.ftsEntriesDeleted).toBe(session.before.groupedRows);
    const after = await snapshotSession(stub, session);
    expect(after.groupedRows).toBe(0);
    expect(after.ftsMatches).toBe(0);
    expect(after.searchIndexState).toBe('grouped_fts_pruned');
    expect(after.messageDigest).toBe(session.before.messageDigest);
    await assertFtsIntegrity(stub);
  });

  it('at the cap, frees the rows and reports stale FTS entries when the markers never fit', async () => {
    const { projectId, stub } = await createProject('stale');
    const session = await seedOldSession(stub, 'stale');

    const result = await recoverWithFtsFailures(stub, projectId, storageFullOn(1, 2));

    expect(result.error).toBeNull();
    expect(result.stopReason).toBe('candidates_exhausted');
    expect(result.ftsStaleRows).toBe(session.before.groupedRows);
    expect(result.ftsEntriesDeleted).toBe(0);
    expect(result.afterBytes).toBeLessThanOrEqual(result.beforeBytes);
    const after = await snapshotSession(stub, session);
    expect(after.groupedRows).toBe(0);
    expect(after.searchIndexState).toBe('grouped_fts_pruned');
    expect(after.messageDigest).toBe(session.before.messageDigest);
    // The stale postings are still in the index...
    expect(after.ftsMatches).toBeGreaterThan(0);
    // ...but search drops them and still finds the session through raw messages.
    expect(await searchFinds(stub, session)).toBe(true);
  });

  it('at the cap, stops with the error when the FTS step fails for another reason', async () => {
    const { projectId, stub } = await createProject('fts-error');
    const [first, second] = await seedSessions(stub, [
      { label: 'ftserrfirst', turns: 3 },
      { label: 'ftserrsecond', turns: 2 },
    ]);

    // Storage-full on the atomic attempt, then an unrelated failure in the FTS step.
    const result = await recoverWithFtsFailures(stub, projectId, (attempt) =>
      attempt === 1
        ? STORAGE_FULL
        : attempt === 2
          ? 'SQLITE_CORRUPT: database disk image is malformed'
          : undefined
    );

    expect(result.stopReason).toBe('transaction_failed');
    expect(result.error).toContain('SQLITE_CORRUPT');
    expect(result.failedSessionId).toBe(first!.sessionId);
    // The rows were already deleted by the fallback's first step, so they are counted.
    expect(result.groupedRowsDeleted).toBe(first!.before.groupedRows);
    expect(result.ftsStaleRows).toBe(first!.before.groupedRows);
    expect((await snapshotSession(stub, first!)).groupedRows).toBe(0);
    // The call stopped: the next session was not touched.
    expect(await snapshotSession(stub, second!)).toEqual(second!.before);
  });

  it('pages grouped rows by index walk, without sorting the rest of the session', async () => {
    const { stub } = await createProject('plan');
    const plan = await runInDurableObject(stub, async (_instance, state) =>
      state.storage.sql
        .exec(`EXPLAIN QUERY PLAN ${GROUPED_PAGE_SIZES_SQL}`, 'session', 0, 0, 10)
        .toArray()
        .map((row) => String(row.detail))
        .join('\n')
    );
    expect(plan).toContain('idx_grouped_messages_session');
    expect(plan).not.toContain('TEMP B-TREE');
  });

  it('leaves sessions in skipSessionIds untouched and prunes the rest', async () => {
    const { projectId, stub } = await createProject('skip');
    const [skipped, pruned] = await seedSessions(stub, [
      { label: 'skipped', turns: 3 },
      { label: 'pruned', turns: 2 },
    ]);

    const result = await recover(projectId, { skipSessionIds: [skipped!.sessionId] });

    expect(result.sessions.map((s) => s.sessionId)).toEqual([pruned!.sessionId]);
    expect(await snapshotSession(stub, skipped!)).toEqual(skipped!.before);
    expect((await snapshotSession(stub, pruned!)).groupedRows).toBe(0);
  });

  it('rejects malformed budgets at the RPC boundary before touching data', async () => {
    const { projectId, stub } = await createProject('invalid');
    const session = await seedOldSession(stub, 'invalid', 2);

    await expect(recover(projectId, { maxRows: Number.NaN })).rejects.toThrow(
      /maxRows must be a positive integer/
    );
    expect(await snapshotSession(stub, session)).toEqual(session.before);
  });
});
