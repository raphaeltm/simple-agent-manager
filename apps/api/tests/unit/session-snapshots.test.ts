import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import {
  buildSessionSnapshotR2Key,
  claimSessionSnapshotRecovery,
  completeActiveSessionSnapshotAsDegraded,
  completeSessionSnapshotRecovery,
  DEFAULT_SESSION_SLEEP_AFTER_MS,
  DEFAULT_SESSION_SLEEP_MAX_ATTEMPTS,
  DEFAULT_SESSION_SNAPSHOT_ENTRY_THRESHOLD_BYTES,
  DEFAULT_SESSION_SNAPSHOT_JSON_BODY_MAX_BYTES,
  DEFAULT_SESSION_SNAPSHOT_R2_PREFIX,
  DEFAULT_SESSION_SNAPSHOT_TOTAL_BUDGET_BYTES,
  DEFAULT_SESSION_SNAPSHOT_TRANSFER_IDLE_TIMEOUT_MS,
  DEFAULT_SESSION_SNAPSHOT_TTL_DAYS,
  getSessionSnapshotConfig,
  isSessionSnapshotSleepReleasable,
  prepareSessionSnapshot,
  recordSessionSnapshotArtifactAuthorization,
  recordSessionSnapshotCaptureFailure,
  recordSessionSnapshotProgress,
  verifySessionSnapshotArtifactsForSleep,
} from '../../src/services/session-snapshots';
import { createSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';

function env(overrides: Partial<Env> = {}): Env {
  return overrides as Env;
}

describe('session snapshot config', () => {
  it('uses constitution-compliant defaults when env vars are absent', () => {
    const config = getSessionSnapshotConfig(env());

    expect(config).toEqual({
      ttlDays: DEFAULT_SESSION_SNAPSHOT_TTL_DAYS,
      totalBudgetBytes: DEFAULT_SESSION_SNAPSHOT_TOTAL_BUDGET_BYTES,
      entryThresholdBytes: DEFAULT_SESSION_SNAPSHOT_ENTRY_THRESHOLD_BYTES,
      transferIdleTimeoutMs: DEFAULT_SESSION_SNAPSHOT_TRANSFER_IDLE_TIMEOUT_MS,
      jsonBodyMaxBytes: DEFAULT_SESSION_SNAPSHOT_JSON_BODY_MAX_BYTES,
      r2Prefix: DEFAULT_SESSION_SNAPSHOT_R2_PREFIX,
    });
    expect(DEFAULT_SESSION_SLEEP_AFTER_MS).toBe(15 * 60 * 1000);
    expect(DEFAULT_SESSION_SLEEP_MAX_ATTEMPTS).toBe(9);
    expect(DEFAULT_SESSION_SNAPSHOT_TOTAL_BUDGET_BYTES).toBe(256 * 1024 * 1024);
    expect(DEFAULT_SESSION_SNAPSHOT_ENTRY_THRESHOLD_BYTES).toBe(256 * 1024 * 1024);
  });

  it('uses positive env overrides and sanitizes the R2 prefix', () => {
    const config = getSessionSnapshotConfig(
      env({
        SESSION_SNAPSHOT_TTL_DAYS: '3',
        SESSION_SNAPSHOT_TOTAL_BUDGET_BYTES: '1234',
        SESSION_SNAPSHOT_ENTRY_THRESHOLD_BYTES: '567',
        SESSION_SNAPSHOT_TRANSFER_IDLE_TIMEOUT_MS: '890',
        SESSION_SNAPSHOT_JSON_BODY_MAX_BYTES: '1024',
        SESSION_SNAPSHOT_R2_PREFIX: '/tenant snapshots/private/',
      })
    );

    expect(config.ttlDays).toBe(3);
    expect(config.totalBudgetBytes).toBe(1234);
    expect(config.entryThresholdBytes).toBe(567);
    expect(config.transferIdleTimeoutMs).toBe(890);
    expect(config.jsonBodyMaxBytes).toBe(1024);
    expect(config.r2Prefix).toBe('tenant-snapshots/private');
  });
});

describe('session snapshot R2 keys', () => {
  it('derives immutable generation-qualified artifact keys', () => {
    const input = env({ SESSION_SNAPSHOT_R2_PREFIX: 'snapshots' });
    const generation = '01JGENERATION00000000000000';

    expect(buildSessionSnapshotR2Key(input, 'chat/../session 1', generation, 'home')).toBe(
      `snapshots/chat-..-session-1/${generation}/home.tar`
    );
    expect(buildSessionSnapshotR2Key(input, 'chat/../session 1', generation, 'wip')).toBe(
      `snapshots/chat-..-session-1/${generation}/wip.bundle`
    );
    expect(buildSessionSnapshotR2Key(input, 'chat/../session 1', generation, 'manifest')).toBe(
      `snapshots/chat-..-session-1/${generation}/manifest.json`
    );
  });
});

describe('session snapshot sleep artifact verification', () => {
  const generation = '01JGENERATION00000000000000';
  const sha = '4ea140588150773ce3aace786aeef7f4049ce100fa649c94fbbddb960f1da942';

  function checksum(hex: string): ArrayBuffer {
    return Uint8Array.from(hex.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16)).buffer;
  }

  it('allows a transcript-only degraded snapshot to release compute after manifest verification', async () => {
    const testEnv = env({
      SESSION_SNAPSHOT_R2_PREFIX: 'snapshots',
      R2: {
        head: async (key: string) =>
          key.endsWith('/manifest.json') ? { size: 120, checksums: {} } : null,
      } as unknown as Env['R2'],
    });
    const snapshot = {
      workspaceId: 'workspace-1',
      chatSessionId: 'chat-1',
      status: 'degraded',
      degradation: 'transcript-only',
      snapshotGeneration: generation,
      manifestR2Key: buildSessionSnapshotR2Key(testEnv, 'chat-1', generation, 'manifest'),
      manifestJson: JSON.stringify({
        version: 1,
        chatSessionId: 'chat-1',
        workspaceId: 'workspace-1',
        status: 'degraded',
        degradation: 'transcript-only',
        skipped: [{ path: 'workspace-snapshot', reason: 'no progress' }],
        artifacts: {},
        createdAt: '2026-08-15T00:00:00.000Z',
      }),
      homeR2Key: null,
      homeSha256: null,
      wipR2Key: null,
      wipSha256: null,
    } as any;

    expect(isSessionSnapshotSleepReleasable(snapshot)).toBe(true);
    await expect(verifySessionSnapshotArtifactsForSleep(testEnv, snapshot)).resolves.toBe(true);
    await expect(
      verifySessionSnapshotArtifactsForSleep(testEnv, {
        ...snapshot,
        workspaceId: 'workspace-2',
      })
    ).resolves.toBe(false);
  });

  it('requires every artifact claimed by a degraded manifest to match R2', async () => {
    const testEnv = env({
      SESSION_SNAPSHOT_R2_PREFIX: 'snapshots',
      R2: {
        head: async (key: string) =>
          key.endsWith('/manifest.json')
            ? { size: 120, checksums: {} }
            : key.endsWith('/wip.bundle')
              ? { size: 42, checksums: { sha256: checksum(sha) } }
              : null,
      } as unknown as Env['R2'],
    });
    const snapshot = {
      workspaceId: 'workspace-1',
      chatSessionId: 'chat-1',
      status: 'degraded',
      degradation: 'home-skipped',
      snapshotGeneration: generation,
      manifestR2Key: buildSessionSnapshotR2Key(testEnv, 'chat-1', generation, 'manifest'),
      manifestJson: JSON.stringify({
        version: 1,
        chatSessionId: 'chat-1',
        workspaceId: 'workspace-1',
        status: 'degraded',
        degradation: 'home-skipped',
        skipped: [{ path: '$HOME', reason: 'snapshot budget exhausted' }],
        artifacts: { wip: { sizeBytes: 42, sha256: sha } },
        createdAt: '2026-08-15T00:00:00.000Z',
      }),
      homeR2Key: null,
      homeSha256: null,
      wipR2Key: buildSessionSnapshotR2Key(testEnv, 'chat-1', generation, 'wip'),
      wipSha256: sha,
    } as any;

    await expect(verifySessionSnapshotArtifactsForSleep(testEnv, snapshot)).resolves.toBe(true);
    await expect(
      verifySessionSnapshotArtifactsForSleep(testEnv, { ...snapshot, wipSha256: '0'.repeat(64) })
    ).resolves.toBe(false);
  });

  it('allows completed direct-upload artifacts whose R2 HEAD has no stored checksum', async () => {
    const testEnv = env({
      SESSION_SNAPSHOT_R2_PREFIX: 'snapshots',
      R2: {
        head: async (key: string) =>
          key.endsWith('/manifest.json')
            ? { size: 120, checksums: {} }
            : key.endsWith('/home.tar')
              ? { size: 42, checksums: {} }
              : null,
      } as unknown as Env['R2'],
    });
    const snapshot = {
      workspaceId: 'workspace-1',
      chatSessionId: 'chat-1',
      status: 'available',
      degradation: 'none',
      snapshotGeneration: generation,
      manifestR2Key: buildSessionSnapshotR2Key(testEnv, 'chat-1', generation, 'manifest'),
      manifestJson: JSON.stringify({
        version: 1,
        chatSessionId: 'chat-1',
        workspaceId: 'workspace-1',
        status: 'available',
        degradation: 'none',
        skipped: [],
        artifacts: { home: { sizeBytes: 42, sha256: sha } },
        createdAt: '2026-08-15T00:00:00.000Z',
      }),
      homeR2Key: buildSessionSnapshotR2Key(testEnv, 'chat-1', generation, 'home'),
      homeSha256: sha,
      wipR2Key: null,
      wipSha256: null,
    } as any;

    await expect(verifySessionSnapshotArtifactsForSleep(testEnv, snapshot)).resolves.toBe(true);
    await expect(
      verifySessionSnapshotArtifactsForSleep(testEnv, {
        ...snapshot,
        manifestJson: JSON.stringify({
          version: 1,
          chatSessionId: 'chat-1',
          workspaceId: 'workspace-1',
          status: 'available',
          degradation: 'none',
          skipped: [],
          artifacts: { home: { sizeBytes: 41, sha256: sha } },
          createdAt: '2026-08-15T00:00:00.000Z',
        }),
      })
    ).resolves.toBe(false);
  });
});

describe('session snapshot progress persistence', () => {
  it('does not let a late prepare reopen a finalized sleeping snapshot', async () => {
    const sqlite = new Database(':memory:');
    try {
      createSchemaTables(sqlite, [schema.sessionSnapshots]);
      sqlite
        .prepare(
          `INSERT INTO session_snapshots
             (id, workspace_id, node_id, project_id, user_id, chat_session_id,
              agent_session_id, runtime, status, degradation, manifest_r2_key,
              manifest_json, snapshot_generation, capture_generation, expires_at,
              sleep_status, sleeping_at, updated_at)
           VALUES ('snapshot-1', 'workspace-1', 'node-1', 'project-1', 'user-1',
              'chat-1', 'agent-1', 'vm', 'degraded', 'transcript-only',
              'snapshots/chat-1/generation-final/manifest.json', '{"status":"degraded"}',
              'generation-final', NULL, '2026-08-20T00:00:00.000Z',
              'sleeping', '2026-08-15T00:00:00.000Z',
              '2026-08-15T00:00:00.000Z')`
        )
        .run();
      const testEnv = env({
        DATABASE: createSqliteD1(sqlite),
        SESSION_SNAPSHOT_R2_PREFIX: 'snapshots',
      });
      const db = drizzle(testEnv.DATABASE, { schema });

      const prepared = await prepareSessionSnapshot(db, testEnv, {
        workspaceId: 'workspace-1',
        nodeId: 'node-1',
        projectId: 'project-1',
        userId: 'user-1',
        chatSessionId: 'chat-1',
        agentSessionId: 'agent-1',
        runtime: 'vm',
      });

      expect(prepared.generation).not.toBe('generation-final');
      expect(
        sqlite
          .prepare(
            `SELECT status, degradation, snapshot_generation, capture_generation,
                    sleep_status, sleeping_at, manifest_json
               FROM session_snapshots WHERE id = 'snapshot-1'`
          )
          .get()
      ).toEqual({
        status: 'degraded',
        degradation: 'transcript-only',
        snapshot_generation: 'generation-final',
        capture_generation: null,
        sleep_status: 'sleeping',
        sleeping_at: '2026-08-15T00:00:00.000Z',
        manifest_json: '{"status":"degraded"}',
      });
    } finally {
      sqlite.close();
    }
  });

  it('preserves a degraded checkpoint while opening a replacement capture generation', async () => {
    const sqlite = new Database(':memory:');
    try {
      createSchemaTables(sqlite, [schema.sessionSnapshots]);
      sqlite
        .prepare(
          `INSERT INTO session_snapshots
             (id, workspace_id, node_id, project_id, user_id, chat_session_id,
              agent_session_id, runtime, status, degradation, manifest_r2_key,
              manifest_json, snapshot_generation, capture_generation, expires_at,
              updated_at)
           VALUES ('snapshot-1', 'workspace-old', 'node-old', 'project-1', 'user-1',
              'chat-1', 'agent-old', 'vm', 'degraded', 'home-skipped',
              'snapshots/chat-1/generation-old/manifest.json', '{"status":"degraded"}',
              'generation-old', NULL, '2026-08-20T00:00:00.000Z',
              '2026-08-15T00:00:00.000Z')`
        )
        .run();
      const testEnv = env({
        DATABASE: createSqliteD1(sqlite),
        SESSION_SNAPSHOT_R2_PREFIX: 'snapshots',
      });
      const db = drizzle(testEnv.DATABASE, { schema });

      const prepared = await prepareSessionSnapshot(db, testEnv, {
        workspaceId: 'workspace-new',
        nodeId: 'node-new',
        projectId: 'project-1',
        userId: 'user-1',
        chatSessionId: 'chat-1',
        agentSessionId: 'agent-new',
        runtime: 'vm',
      });

      const row = sqlite
        .prepare(
          `SELECT workspace_id, node_id, agent_session_id, status, degradation,
                  snapshot_generation, capture_generation, manifest_json
             FROM session_snapshots WHERE id = 'snapshot-1'`
        )
        .get();
      expect(row).toEqual({
        workspace_id: 'workspace-new',
        node_id: 'node-new',
        agent_session_id: 'agent-new',
        status: 'degraded',
        degradation: 'home-skipped',
        snapshot_generation: 'generation-old',
        capture_generation: prepared.generation,
        manifest_json: '{"status":"degraded"}',
      });
    } finally {
      sqlite.close();
    }
  });

  it('records progress and terminalizes the active generation even when a previous snapshot is available', async () => {
    const sqlite = new Database(':memory:');
    try {
      createSchemaTables(sqlite, [schema.sessionSnapshots]);
      sqlite
        .prepare(
          `INSERT INTO session_snapshots
             (id, workspace_id, user_id, chat_session_id, agent_session_id, runtime, status,
              degradation, manifest_r2_key, snapshot_generation, capture_generation, expires_at,
              updated_at)
           VALUES ('snapshot-1', 'workspace-1', 'user-1', 'chat-1', 'agent-1', 'vm',
              'available', 'none', 'snapshots/chat-1/previous/manifest.json', 'previous',
              'capture-1', '2026-08-20T00:00:00.000Z', '2026-08-15T00:00:00.000Z')`
        )
        .run();
      const r2 = { put: vi.fn(), delete: vi.fn(async () => undefined), head: vi.fn() };
      const testEnv = env({
        DATABASE: createSqliteD1(sqlite),
        R2: r2 as unknown as Env['R2'],
        SESSION_SNAPSHOT_R2_PREFIX: 'snapshots',
      });
      const db = drizzle(testEnv.DATABASE, { schema });

      await expect(
        recordSessionSnapshotProgress(db, {
          chatSessionId: 'chat-1',
          generation: 'capture-1',
          now: new Date('2026-08-15T00:01:00.000Z'),
        })
      ).resolves.toBe(true);
      expect(
        sqlite.prepare(`SELECT updated_at FROM session_snapshots WHERE id = 'snapshot-1'`).get()
      ).toEqual({ updated_at: '2026-08-15T00:01:00.000Z' });

      await expect(
        completeActiveSessionSnapshotAsDegraded(db, testEnv, {
          workspaceId: 'workspace-1',
          chatSessionId: 'chat-1',
          agentSessionId: 'agent-1',
          runtime: 'vm',
          captureGeneration: 'capture-1',
          acpSessionId: 'acp-1',
          agentType: 'openai-codex',
          reason: 'Workspace snapshot made no progress for 120000ms',
        })
      ).resolves.toBe(true);

      const row = sqlite
        .prepare(
          `SELECT status, degradation, snapshot_generation, capture_generation, manifest_json
           FROM session_snapshots WHERE id = 'snapshot-1'`
        )
        .get() as {
        status: string;
        degradation: string;
        snapshot_generation: string;
        capture_generation: string | null;
        manifest_json: string;
      };
      expect(row.status).toBe('degraded');
      expect(row.degradation).toBe('transcript-only');
      expect(row.snapshot_generation).toBe('capture-1');
      expect(row.capture_generation).toBeNull();
      expect(JSON.parse(row.manifest_json)).toMatchObject({
        status: 'degraded',
        degradation: 'transcript-only',
        artifacts: {},
      });
      expect(JSON.parse(row.manifest_json)).not.toHaveProperty('acpSessionId');
      expect(JSON.parse(row.manifest_json)).not.toHaveProperty('agentType');
      expect(r2.put).toHaveBeenCalledWith(
        'snapshots/chat-1/capture-1/manifest.json',
        expect.stringContaining('Workspace snapshot made no progress'),
        expect.objectContaining({ httpMetadata: { contentType: 'application/json' } })
      );
    } finally {
      sqlite.close();
    }
  });

  it('records direct-upload authorization only for the active capture generation', async () => {
    const sqlite = new Database(':memory:');
    try {
      const sha = '4ea140588150773ce3aace786aeef7f4049ce100fa649c94fbbddb960f1da942';
      createSchemaTables(sqlite, [schema.sessionSnapshots]);
      const r2 = { put: vi.fn(), delete: vi.fn(async () => undefined), head: vi.fn() };
      const testEnv = env({
        DATABASE: createSqliteD1(sqlite),
        R2: r2 as unknown as Env['R2'],
        SESSION_SNAPSHOT_R2_PREFIX: 'snapshots',
      });
      const db = drizzle(testEnv.DATABASE, { schema });
      const prepared = await prepareSessionSnapshot(db, testEnv, {
        workspaceId: 'workspace-1',
        nodeId: 'node-1',
        projectId: 'project-1',
        userId: 'user-1',
        chatSessionId: 'chat-1',
        agentSessionId: 'agent-1',
        runtime: 'vm',
      });

      await expect(
        recordSessionSnapshotArtifactAuthorization(db, {
          chatSessionId: 'chat-1',
          generation: 'stale-generation',
          artifact: 'home',
          sizeBytes: 4,
          sha256: sha,
        })
      ).resolves.toBe(false);
      await expect(
        recordSessionSnapshotArtifactAuthorization(db, {
          chatSessionId: 'chat-1',
          generation: prepared.generation,
          artifact: 'home',
          sizeBytes: 4,
          sha256: sha.toUpperCase(),
        })
      ).resolves.toBe(true);

      expect(
        sqlite
          .prepare(
            `SELECT authorized_home_bytes, authorized_home_sha256,
                    authorized_wip_bytes, authorized_wip_sha256
             FROM session_snapshots WHERE chat_session_id = 'chat-1'`
          )
          .get()
      ).toEqual({
        authorized_home_bytes: 4,
        authorized_home_sha256: sha,
        authorized_wip_bytes: null,
        authorized_wip_sha256: null,
      });
    } finally {
      sqlite.close();
    }
  });

  it('records capture failure only for the active capture generation', async () => {
    const sqlite = new Database(':memory:');
    try {
      createSchemaTables(sqlite, [schema.sessionSnapshots]);
      sqlite
        .prepare(
          `INSERT INTO session_snapshots
             (id, workspace_id, user_id, chat_session_id, agent_session_id, runtime, status,
              degradation, manifest_r2_key, snapshot_generation, capture_generation, expires_at,
              updated_at)
           VALUES ('snapshot-1', 'workspace-1', 'user-1', 'chat-1', 'agent-1', 'vm',
              'available', 'none', 'snapshots/chat-1/previous/manifest.json', 'previous',
              'capture-1', '2026-08-20T00:00:00.000Z', '2026-08-15T00:00:00.000Z')`
        )
        .run();
      const testEnv = env({
        DATABASE: createSqliteD1(sqlite),
        SESSION_LIFECYCLE_ERROR_MAX_LENGTH: '24',
      });
      const db = drizzle(testEnv.DATABASE, { schema });

      await expect(
        recordSessionSnapshotCaptureFailure(db, testEnv, {
          chatSessionId: 'chat-1',
          generation: 'stale-capture',
          error: 'this should not be recorded',
        })
      ).resolves.toBe(false);

      await expect(
        recordSessionSnapshotCaptureFailure(db, testEnv, {
          chatSessionId: 'chat-1',
          generation: 'capture-1',
          error: 'real capture failure with sensitive tail',
          now: new Date('2026-08-15T00:01:00.000Z'),
        })
      ).resolves.toBe(true);

      expect(
        sqlite
          .prepare(`SELECT capture_error, updated_at FROM session_snapshots WHERE id = 'snapshot-1'`)
          .get()
      ).toEqual({
        capture_error: 'real capture failure wit',
        updated_at: '2026-08-15T00:01:00.000Z',
      });
    } finally {
      sqlite.close();
    }
  });
});

describe('session snapshot recovery lifecycle', () => {
  it('allows a degraded sleeping snapshot to be claimed for wake', async () => {
    const sqlite = new Database(':memory:');
    try {
      createSchemaTables(sqlite, [schema.sessionSnapshots]);
      sqlite
        .prepare(
          `INSERT INTO session_snapshots
             (id, workspace_id, node_id, project_id, user_id, chat_session_id,
              agent_session_id, runtime, status, degradation, manifest_r2_key,
              manifest_json, snapshot_generation, expires_at, sleep_status,
              sleeping_at, recovery_attempts, updated_at)
           VALUES ('snapshot-1', 'workspace-1', 'node-1', 'project-1', 'user-1',
              'chat-1', 'agent-1', 'vm', 'degraded', 'transcript-only',
              'snapshots/chat-1/generation-final/manifest.json', '{"status":"degraded"}',
              'generation-final', '2026-08-20T00:00:00.000Z', 'sleeping',
              '2026-08-15T00:00:00.000Z', 0, '2026-08-15T00:00:00.000Z')`
        )
        .run();
      const testEnv = env({ DATABASE: createSqliteD1(sqlite) });
      const db = drizzle(testEnv.DATABASE, { schema });

      await expect(
        claimSessionSnapshotRecovery(db, testEnv, {
          chatSessionId: 'chat-1',
          userId: 'user-1',
          taskId: 'wake-task-1',
          now: new Date('2026-08-15T00:05:00.000Z'),
        })
      ).resolves.toEqual({ status: 'claimed', taskId: 'wake-task-1' });

      expect(
        sqlite
          .prepare(
            `SELECT recovery_status, recovery_task_id, recovery_attempts, recovery_error
               FROM session_snapshots WHERE id = 'snapshot-1'`
          )
          .get()
      ).toEqual({
        recovery_status: 'waking',
        recovery_task_id: 'wake-task-1',
        recovery_attempts: 1,
        recovery_error: null,
      });
    } finally {
      sqlite.close();
    }
  });

  it('clears the sleeping claim when snapshot recovery completes', async () => {
    const sqlite = new Database(':memory:');
    try {
      createSchemaTables(sqlite, [schema.sessionSnapshots]);
      sqlite
        .prepare(
          `INSERT INTO session_snapshots
             (id, workspace_id, node_id, project_id, user_id, chat_session_id,
              agent_session_id, runtime, status, degradation, manifest_r2_key,
              manifest_json, snapshot_generation, expires_at, sleep_status,
              sleeping_at, recovery_status, recovery_task_id, recovery_workspace_id,
              recovery_attempts, updated_at)
           VALUES ('snapshot-1', 'workspace-old', 'node-1', 'project-1', 'user-1',
              'chat-1', 'agent-1', 'vm', 'degraded', 'transcript-only',
              'snapshots/chat-1/generation-final/manifest.json', '{"status":"degraded"}',
              'generation-final', '2026-08-20T00:00:00.000Z', 'sleeping',
              '2026-08-15T00:00:00.000Z', 'waking', 'wake-task-1',
              'workspace-new', 1, '2026-08-15T00:00:00.000Z')`
        )
        .run();
      const testEnv = env({ DATABASE: createSqliteD1(sqlite) });
      const db = drizzle(testEnv.DATABASE, { schema });

      await expect(
        completeSessionSnapshotRecovery(db, 'chat-1', 'wake-task-1', 'workspace-new')
      ).resolves.toBe(true);

      expect(
        sqlite
          .prepare(
            `SELECT recovery_status, recovery_task_id, recovery_workspace_id,
                    recovery_error, sleep_status, sleep_error, sleeping_at, restored_at
               FROM session_snapshots WHERE id = 'snapshot-1'`
          )
          .get()
      ).toEqual({
        recovery_status: 'restored',
        recovery_task_id: 'wake-task-1',
        recovery_workspace_id: 'workspace-new',
        recovery_error: null,
        sleep_status: null,
        sleep_error: null,
        sleeping_at: null,
        restored_at: expect.any(String),
      });
    } finally {
      sqlite.close();
    }
  });
});
