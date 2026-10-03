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
// capture-generation predicates are actually evaluated (.claude/rules/28).

const CHAT = 'chat-1';

interface Harness {
  sqlite: Database.Database;
  env: Env;
  db: ReturnType<typeof drizzle<typeof schema>>;
  deleted: string[];
}

function keysFor(env: Env, generation: string): Record<'home' | 'wip' | 'manifest', string> {
  return {
    home: buildSessionSnapshotR2Key(env, CHAT, generation, 'home'),
    wip: buildSessionSnapshotR2Key(env, CHAT, generation, 'wip'),
    manifest: buildSessionSnapshotR2Key(env, CHAT, generation, 'manifest'),
  };
}

function harness(row: {
  status: string;
  degradation?: string;
  snapshotGeneration: string | null;
  captureGeneration: string | null;
  recordedGeneration: string;
}): Harness {
  const sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [schema.sessionSnapshots]);
  const deleted: string[] = [];
  const env = {
    DATABASE: createSqliteD1(sqlite),
    SESSION_SNAPSHOT_R2_PREFIX: 'snapshots',
    R2: {
      delete: vi.fn(async (keys: string | string[]) => {
        deleted.push(...(Array.isArray(keys) ? keys : [keys]));
      }),
      put: vi.fn(async () => undefined),
    },
  } as unknown as Env;
  const recorded = keysFor(env, row.recordedGeneration);
  sqlite
    .prepare(
      `INSERT INTO session_snapshots
         (id, project_id, workspace_id, node_id, user_id, chat_session_id, agent_session_id,
          runtime, status, degradation, home_r2_key, wip_r2_key, manifest_r2_key,
          snapshot_generation, capture_generation, expires_at, updated_at)
       VALUES ('snapshot-1', 'project-1', 'workspace-1', 'node-1', 'user-1', ?, 'agent-1',
          'vm', ?, ?, ?, ?, ?, ?, ?, '2026-10-10T00:00:00.000Z', '2026-10-03T00:00:00.000Z')`
    )
    .run(
      CHAT,
      row.status,
      row.degradation ?? 'none',
      recorded.home,
      recorded.wip,
      recorded.manifest,
      row.snapshotGeneration,
      row.captureGeneration
    );
  return { sqlite, env, db: drizzle(env.DATABASE, { schema }), deleted };
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

  // Controlled ordering (.claude/rules/62): the superseded capture completes
  // after prepare read the row but before its update lands. Its keys are then
  // the live snapshot's and must survive.
  it('never deletes a superseded capture that completed between the read and the replacement', async () => {
    const h = harness({
      status: 'available',
      snapshotGeneration: 'generation-complete',
      captureGeneration: 'capture-old',
      recordedGeneration: 'generation-complete',
    });
    const old = keysFor(h.env, 'capture-old');
    const base = h.env.DATABASE;
    let interleaved = false;
    const completeOldCapture = () => {
      interleaved = true;
      h.sqlite
        .prepare(
          `UPDATE session_snapshots
              SET snapshot_generation = 'capture-old', capture_generation = NULL,
                  home_r2_key = ?, wip_r2_key = ?, manifest_r2_key = ?
            WHERE chat_session_id = ?`
        )
        .run(old.home, old.wip, old.manifest, CHAT);
    };
    const interleavingDatabase = {
      ...base,
      prepare: (sql: string) => {
        const statement = base.prepare(sql);
        if (!/^update "session_snapshots"/i.test(sql)) return statement;
        const withInterleave = <T extends { run: () => Promise<unknown> }>(target: T): T => ({
          ...target,
          run: async () => {
            if (!interleaved) completeOldCapture();
            return target.run();
          },
        });
        return {
          ...withInterleave(statement),
          bind: (...params: unknown[]) => withInterleave(statement.bind(...params)),
        };
      },
    } as unknown as D1Database;
    try {
      await prepareSessionSnapshot(
        drizzle(interleavingDatabase, { schema }),
        h.env,
        prepareInput()
      );

      expect(interleaved).toBe(true);
      expect(h.deleted).not.toContain(old.home);
      expect(h.deleted).not.toContain(old.wip);
      expect(h.deleted).not.toContain(old.manifest);
      expect(
        h.sqlite
          .prepare(`SELECT wip_r2_key FROM session_snapshots WHERE chat_session_id = ?`)
          .get(CHAT)
      ).toEqual({ wip_r2_key: old.wip });
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
      await completeSessionSnapshot(h.db, h.env, {
        workspaceId: 'workspace-1',
        chatSessionId: CHAT,
        agentSessionId: 'agent-1',
        runtime: 'vm',
        baseCommit: null,
        captureGeneration: 'capture-1',
        status: 'degraded',
        degradation: 'home-skipped',
        manifest: {
          version: 1,
          chatSessionId: CHAT,
          workspaceId: 'workspace-1',
          status: 'degraded',
          degradation: 'home-skipped',
          skipped: [{ path: '$HOME', reason: 'snapshot artifact exceeds remaining budget' }],
          artifacts: { wip: { sizeBytes: 10, sha256: 'a'.repeat(64) } },
          createdAt: '2026-10-03T00:00:00.000Z',
        },
        artifactSizes: { wipBytes: 10 },
        artifactSha256: { wipSha256: 'a'.repeat(64) },
      });

      const replaced = keysFor(h.env, 'generation-complete');
      const completed = keysFor(h.env, 'capture-1');
      expect(h.deleted.sort()).toEqual(
        [replaced.home, replaced.wip, replaced.manifest, completed.home].sort()
      );
      expect(
        h.sqlite
          .prepare(
            `SELECT home_r2_key, wip_r2_key, manifest_r2_key FROM session_snapshots WHERE chat_session_id = ?`
          )
          .get(CHAT)
      ).toEqual({
        home_r2_key: null,
        wip_r2_key: completed.wip,
        manifest_r2_key: completed.manifest,
      });
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
      expect(h.sqlite.prepare(`SELECT COUNT(*) AS n FROM session_snapshots`).get()).toEqual({
        n: 0,
      });
    } finally {
      h.sqlite.close();
    }
  });
});
