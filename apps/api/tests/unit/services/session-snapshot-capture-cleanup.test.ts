import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import {
  buildSessionSnapshotR2Key,
  completeSessionSnapshot,
  deleteSessionSnapshotState,
  prepareSessionSnapshot,
  recordSessionSnapshotCaptureFailure,
} from '../../../src/services/session-snapshots';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

// Regression coverage for leaked snapshot uploads: every capture that never
// completed left its wip.bundle in R2 (15 orphaned 246.6 MiB bundles for one
// stuck session on 2026-10-03). Runs on a real SQLite engine so the
// capture-generation predicates are actually evaluated (.claude/rules/28), with
// an unrelated session in the same table so a dropped scoping predicate shows.

const CHAT = 'chat-1';
const OTHER_CHAT = 'chat-2';

type Keys = Record<'home' | 'wip' | 'manifest', string>;

interface Harness {
  sqlite: Database.Database;
  env: Env;
  db: ReturnType<typeof drizzle<typeof schema>>;
  deleted: string[];
}

function keysFor(env: Env, generation: string, chatSessionId = CHAT): Keys {
  return {
    home: buildSessionSnapshotR2Key(env, chatSessionId, generation, 'home'),
    wip: buildSessionSnapshotR2Key(env, chatSessionId, generation, 'wip'),
    manifest: buildSessionSnapshotR2Key(env, chatSessionId, generation, 'manifest'),
  };
}

function insertRow(
  sqlite: Database.Database,
  env: Env,
  row: {
    id: string;
    chatSessionId: string;
    status: string;
    degradation?: string;
    snapshotGeneration: string | null;
    captureGeneration: string | null;
    recordedGeneration: string;
  }
): void {
  const recorded = keysFor(env, row.recordedGeneration, row.chatSessionId);
  sqlite
    .prepare(
      `INSERT INTO session_snapshots
         (id, project_id, workspace_id, node_id, user_id, chat_session_id, agent_session_id,
          runtime, status, degradation, home_r2_key, wip_r2_key, manifest_r2_key,
          snapshot_generation, capture_generation, expires_at, updated_at)
       VALUES (?, 'project-1', 'workspace-1', 'node-1', 'user-1', ?, 'agent-1',
          'vm', ?, ?, ?, ?, ?, ?, ?, '2026-10-10T00:00:00.000Z', '2026-10-03T00:00:00.000Z')`
    )
    .run(
      row.id,
      row.chatSessionId,
      row.status,
      row.degradation ?? 'none',
      recorded.home,
      recorded.wip,
      recorded.manifest,
      row.snapshotGeneration,
      row.captureGeneration
    );
}

function harness(
  row: {
    status: string;
    degradation?: string;
    snapshotGeneration: string | null;
    captureGeneration: string | null;
    recordedGeneration: string;
  },
  options: { r2DeleteFails?: boolean } = {}
): Harness {
  const sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [schema.sessionSnapshots]);
  const deleted: string[] = [];
  const env = {
    DATABASE: createSqliteD1(sqlite),
    SESSION_SNAPSHOT_R2_PREFIX: 'snapshots',
    R2: {
      delete: vi.fn(async (keys: string | string[]) => {
        if (options.r2DeleteFails) throw new Error('R2 unavailable');
        deleted.push(...(Array.isArray(keys) ? keys : [keys]));
      }),
      put: vi.fn(async () => undefined),
    },
  } as unknown as Env;
  insertRow(sqlite, env, { id: 'snapshot-1', chatSessionId: CHAT, ...row });
  // An unrelated session with its own in-flight capture: nothing here may touch it.
  insertRow(sqlite, env, {
    id: 'snapshot-2',
    chatSessionId: OTHER_CHAT,
    status: 'pending',
    snapshotGeneration: null,
    captureGeneration: 'other-capture',
    recordedGeneration: 'other-capture',
  });
  return { sqlite, env, db: drizzle(env.DATABASE, { schema }), deleted };
}

function expectUnrelatedSessionUntouched(h: Harness): void {
  expect(h.deleted.filter((key) => key.includes(`/${OTHER_CHAT}/`))).toEqual([]);
  const other = keysFor(h.env, 'other-capture', OTHER_CHAT);
  expect(
    h.sqlite
      .prepare(
        `SELECT capture_generation, home_r2_key, wip_r2_key, manifest_r2_key
           FROM session_snapshots WHERE chat_session_id = ?`
      )
      .get(OTHER_CHAT)
  ).toEqual({
    capture_generation: 'other-capture',
    home_r2_key: other.home,
    wip_r2_key: other.wip,
    manifest_r2_key: other.manifest,
  });
}

function rowFor(h: Harness) {
  return h.sqlite
    .prepare(
      `SELECT status, snapshot_generation, capture_generation, home_r2_key, wip_r2_key,
              manifest_r2_key, capture_error
         FROM session_snapshots WHERE chat_session_id = ?`
    )
    .get(CHAT) as Record<string, string | null>;
}

function prepareInput() {
  return {
    workspaceId: 'workspace-1',
    nodeId: 'node-1',
    projectId: 'project-1',
    userId: 'user-1',
    chatSessionId: CHAT,
    agentSessionId: 'agent-1',
    runtime: 'vm',
  };
}

/**
 * Runs `interleave` against the real SQLite engine immediately before the first
 * session_snapshots UPDATE lands: a concurrent writer that wins the race between
 * prepare's read and its write (.claude/rules/62, controlled ordering).
 */
function interleaveBeforeFirstUpdate(base: D1Database, interleave: () => void) {
  let interleaved = false;
  const database = {
    ...base,
    prepare: (sql: string) => {
      const statement = base.prepare(sql);
      if (!/^update "session_snapshots"/i.test(sql)) return statement;
      const withInterleave = <T extends { run: () => Promise<unknown> }>(target: T): T => ({
        ...target,
        run: async () => {
          if (!interleaved) {
            interleaved = true;
            interleave();
          }
          return target.run();
        },
      });
      return {
        ...withInterleave(statement),
        bind: (...params: unknown[]) => withInterleave(statement.bind(...params)),
      };
    },
  } as unknown as D1Database;
  return { database, wasInterleaved: () => interleaved };
}

function completeCapture(h: Harness, generation: string): Keys {
  const keys = keysFor(h.env, generation);
  h.sqlite
    .prepare(
      `UPDATE session_snapshots
          SET status = 'available', degradation = 'none', snapshot_generation = ?,
              capture_generation = NULL, home_r2_key = ?, wip_r2_key = ?, manifest_r2_key = ?
        WHERE chat_session_id = ?`
    )
    .run(generation, keys.home, keys.wip, keys.manifest, CHAT);
  return keys;
}

describe('abandoned session snapshot capture cleanup', () => {
  it('deletes a superseded capture of a never-completed snapshot when the next capture starts', async () => {
    const h = harness({
      status: 'pending',
      snapshotGeneration: null,
      captureGeneration: 'capture-old',
      recordedGeneration: 'capture-old',
    });
    try {
      const prepared = await prepareSessionSnapshot(h.db, h.env, prepareInput());

      const old = keysFor(h.env, 'capture-old');
      expect(h.deleted.sort()).toEqual([old.home, old.manifest, old.wip].sort());
      expect(h.deleted).not.toContain(keysFor(h.env, prepared.generation).wip);
      expectUnrelatedSessionUntouched(h);
    } finally {
      h.sqlite.close();
    }
  });

  it('keeps the completed snapshot while deleting the capture it superseded', async () => {
    const h = harness({
      status: 'available',
      snapshotGeneration: 'generation-complete',
      captureGeneration: 'capture-old',
      recordedGeneration: 'generation-complete',
    });
    try {
      await prepareSessionSnapshot(h.db, h.env, prepareInput());

      const old = keysFor(h.env, 'capture-old');
      expect(h.deleted.sort()).toEqual([old.home, old.manifest, old.wip].sort());
      const complete = keysFor(h.env, 'generation-complete');
      expect(h.deleted).not.toContain(complete.home);
      expect(h.deleted).not.toContain(complete.wip);
      expect(h.deleted).not.toContain(complete.manifest);
      expectUnrelatedSessionUntouched(h);
    } finally {
      h.sqlite.close();
    }
  });

  it('deletes nothing when the first capture starts', async () => {
    const h = harness({
      status: 'available',
      snapshotGeneration: 'generation-complete',
      captureGeneration: null,
      recordedGeneration: 'generation-complete',
    });
    try {
      const prepared = await prepareSessionSnapshot(h.db, h.env, prepareInput());

      expect(prepared.generation).toBeTruthy();
      expect(h.deleted).toEqual([]);
    } finally {
      h.sqlite.close();
    }
  });

  // The superseded capture completes after prepare read the row but before its
  // update lands. Prepare must lose (compare-and-swap) instead of replacing a
  // snapshot that just became live, and must not delete its objects.
  it.each([
    ['a never-completed snapshot', 'pending', null, 'capture-old'],
    [
      'a snapshot with an older completed generation',
      'available',
      'generation-complete',
      'generation-complete',
    ],
  ])(
    'does not replace or delete a capture that completed between the read and the write on %s',
    async (_label, status, snapshotGeneration, recordedGeneration) => {
      const h = harness({
        status,
        snapshotGeneration,
        captureGeneration: 'capture-old',
        recordedGeneration,
      });
      try {
        let completed: Keys | null = null;
        const racing = interleaveBeforeFirstUpdate(h.env.DATABASE, () => {
          completed = completeCapture(h, 'capture-old');
        });

        await expect(
          prepareSessionSnapshot(drizzle(racing.database, { schema }), h.env, prepareInput())
        ).rejects.toThrow('lost a race with a concurrent capture or completion');

        expect(racing.wasInterleaved()).toBe(true);
        expect(h.deleted).toEqual([]);
        const live = completed as unknown as Keys;
        expect(rowFor(h)).toMatchObject({
          status: 'available',
          snapshot_generation: 'capture-old',
          capture_generation: null,
          home_r2_key: live.home,
          wip_r2_key: live.wip,
          manifest_r2_key: live.manifest,
        });
        expectUnrelatedSessionUntouched(h);
      } finally {
        h.sqlite.close();
      }
    }
  );

  it('loses to a sibling prepare instead of deleting the capture that sibling just started', async () => {
    const h = harness({
      status: 'pending',
      snapshotGeneration: null,
      captureGeneration: 'capture-old',
      recordedGeneration: 'capture-old',
    });
    try {
      const sibling = keysFor(h.env, 'capture-sibling');
      const racing = interleaveBeforeFirstUpdate(h.env.DATABASE, () => {
        h.sqlite
          .prepare(
            `UPDATE session_snapshots
                SET capture_generation = 'capture-sibling', home_r2_key = ?, wip_r2_key = ?,
                    manifest_r2_key = ?
              WHERE chat_session_id = ?`
          )
          .run(sibling.home, sibling.wip, sibling.manifest, CHAT);
      });

      await expect(
        prepareSessionSnapshot(drizzle(racing.database, { schema }), h.env, prepareInput())
      ).rejects.toThrow('lost a race with a concurrent capture or completion');

      expect(h.deleted).toEqual([]);
      expect(rowFor(h)).toMatchObject({
        capture_generation: 'capture-sibling',
        wip_r2_key: sibling.wip,
      });
    } finally {
      h.sqlite.close();
    }
  });

  it('deletes a failed capture uploads but leaves its manifest key for a transcript-only completion', async () => {
    const h = harness({
      status: 'pending',
      snapshotGeneration: null,
      captureGeneration: 'capture-1',
      recordedGeneration: 'capture-1',
    });
    try {
      await expect(
        recordSessionSnapshotCaptureFailure(h.db, h.env, {
          chatSessionId: CHAT,
          generation: 'stale-capture',
          error: 'not current',
        })
      ).resolves.toBe(false);
      expect(h.deleted).toEqual([]);

      await expect(
        recordSessionSnapshotCaptureFailure(h.db, h.env, {
          chatSessionId: CHAT,
          generation: 'capture-1',
          error: 'snapshot control plane returned HTTP 400: Snapshot request body is too large',
        })
      ).resolves.toBe(true);

      const failed = keysFor(h.env, 'capture-1');
      expect(h.deleted.sort()).toEqual([failed.home, failed.wip].sort());
      expectUnrelatedSessionUntouched(h);
    } finally {
      h.sqlite.close();
    }
  });

  it('deletes uploads a degraded completion did not record and keeps the ones it did', async () => {
    const h = harness({
      status: 'available',
      snapshotGeneration: 'generation-complete',
      captureGeneration: 'capture-1',
      recordedGeneration: 'generation-complete',
    });
    try {
      await completeSessionSnapshot(h.db, h.env, degradedWipOnlyCompletion());

      const replaced = keysFor(h.env, 'generation-complete');
      const completed = keysFor(h.env, 'capture-1');
      expect(h.deleted.sort()).toEqual(
        [replaced.home, replaced.wip, replaced.manifest, completed.home].sort()
      );
      expect(rowFor(h)).toMatchObject({
        home_r2_key: null,
        wip_r2_key: completed.wip,
        manifest_r2_key: completed.manifest,
      });
      expectUnrelatedSessionUntouched(h);
    } finally {
      h.sqlite.close();
    }
  });

  it('explicit snapshot deletion also removes an in-flight capture uploads', async () => {
    const h = harness({
      status: 'available',
      snapshotGeneration: 'generation-complete',
      captureGeneration: 'capture-1',
      recordedGeneration: 'generation-complete',
    });
    try {
      await expect(deleteSessionSnapshotState(h.db, h.env, CHAT)).resolves.toBe(true);

      const complete = keysFor(h.env, 'generation-complete');
      const inFlight = keysFor(h.env, 'capture-1');
      expect(h.deleted.sort()).toEqual(
        [
          complete.home,
          complete.wip,
          complete.manifest,
          inFlight.home,
          inFlight.wip,
          inFlight.manifest,
        ].sort()
      );
      expect(
        h.sqlite
          .prepare(`SELECT COUNT(*) AS n FROM session_snapshots WHERE chat_session_id = ?`)
          .get(CHAT)
      ).toEqual({ n: 0 });
      expectUnrelatedSessionUntouched(h);
    } finally {
      h.sqlite.close();
    }
  });

  // The incident this cleanup belongs to was "capture machinery failures keep
  // sessions awake", so a failing best-effort delete must never block capture.
  it('never lets a failing best-effort R2 delete block prepare, failure reports or completion', async () => {
    const h = harness(
      {
        status: 'available',
        snapshotGeneration: 'generation-complete',
        captureGeneration: 'capture-1',
        recordedGeneration: 'generation-complete',
      },
      { r2DeleteFails: true }
    );
    try {
      await expect(
        recordSessionSnapshotCaptureFailure(h.db, h.env, {
          chatSessionId: CHAT,
          generation: 'capture-1',
          error: 'upload failed',
        })
      ).resolves.toBe(true);
      expect(rowFor(h).capture_error).toBe('upload failed');

      const prepared = await prepareSessionSnapshot(h.db, h.env, prepareInput());
      expect(rowFor(h).capture_generation).toBe(prepared.generation);

      await completeSessionSnapshot(h.db, h.env, {
        ...degradedWipOnlyCompletion(),
        captureGeneration: prepared.generation,
      });
      expect(rowFor(h)).toMatchObject({
        status: 'degraded',
        snapshot_generation: prepared.generation,
        capture_generation: null,
      });
    } finally {
      h.sqlite.close();
    }
  });

  it('keeps the row when explicit deletion cannot remove the objects first', async () => {
    const h = harness(
      {
        status: 'available',
        snapshotGeneration: 'generation-complete',
        captureGeneration: null,
        recordedGeneration: 'generation-complete',
      },
      { r2DeleteFails: true }
    );
    try {
      await expect(deleteSessionSnapshotState(h.db, h.env, CHAT)).rejects.toThrow('R2 unavailable');
      expect(rowFor(h).snapshot_generation).toBe('generation-complete');
    } finally {
      h.sqlite.close();
    }
  });
});

function degradedWipOnlyCompletion() {
  return {
    workspaceId: 'workspace-1',
    chatSessionId: CHAT,
    agentSessionId: 'agent-1',
    runtime: 'vm',
    baseCommit: null,
    captureGeneration: 'capture-1',
    status: 'degraded' as const,
    degradation: 'home-skipped' as const,
    manifest: {
      version: 1 as const,
      chatSessionId: CHAT,
      workspaceId: 'workspace-1',
      status: 'degraded' as const,
      degradation: 'home-skipped' as const,
      skipped: [{ path: '$HOME', reason: 'snapshot artifact exceeds remaining budget' }],
      artifacts: { wip: { sizeBytes: 10, sha256: 'a'.repeat(64) } },
      createdAt: '2026-10-03T00:00:00.000Z',
    },
    artifactSizes: { wipBytes: 10 },
    artifactSha256: { wipSha256: 'a'.repeat(64) },
  };
}
