import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import migrationSql from '../../../src/db/migrations/0106_diagnostic_incidents.sql?raw';
import type { Env } from '../../../src/env';
import { reconcileDiagnosticIncidents } from '../../../src/services/diagnostic-incident-reconciliation';
import { createSqliteD1 } from '../../helpers/sqlite-d1';

interface Head {
  size: number;
  customMetadata?: Record<string, string>;
}

class ReconciliationR2 {
  readonly heads = new Map<string, Head>();
  readonly head = vi.fn(async (key: string) => (this.heads.get(key) ?? null) as R2Object | null);
  readonly delete = vi.fn(async (key: string) => {
    this.heads.delete(key);
  });
}

describe('diagnostic incident reconciliation', () => {
  let main: Database.Database;
  let observability: Database.Database;
  let r2: ReconciliationR2;
  let env: Env;

  beforeEach(() => {
    main = new Database(':memory:');
    main.exec(migrationSql);
    observability = new Database(':memory:');
    observability.exec(`
      CREATE TABLE platform_errors (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL,
        stack TEXT, context TEXT, user_id TEXT, node_id TEXT, workspace_id TEXT,
        ip_address TEXT, user_agent TEXT, timestamp INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
    `);
    r2 = new ReconciliationR2();
    env = {
      DATABASE: createSqliteD1(main),
      OBSERVABILITY_DATABASE: createSqliteD1(observability),
      R2: r2 as unknown as R2Bucket,
      VM_INCIDENT_PENDING_TIMEOUT_MINUTES: '1',
      VM_INCIDENT_RECONCILE_BATCH_SIZE: '20',
    } as Env;
  });

  function insertIncident(params: {
    id: string;
    status: string;
    artifactStatus: string;
    objectKey: string;
    expectedBytes?: number;
    checksum?: string;
    expiresAt?: string;
    deleteAfter?: string;
    updatedAt?: string;
  }) {
    const expiresAt = params.expiresAt ?? '2099-01-01T00:00:00.000Z';
    const deleteAfter = params.deleteAfter ?? '2099-02-01T00:00:00.000Z';
    const updatedAt = params.updatedAt ?? '2020-01-01T00:00:00.000Z';
    main
      .prepare(
        `INSERT INTO diagnostic_incidents
         (id, platform_error_id, node_id, status, artifact_count, total_bytes, preview_json,
          expires_at, delete_after, created_at, updated_at)
         VALUES (?, ?, 'node-1', ?, 1, ?, '{"safe":true}', ?, ?, ?, ?)`
      )
      .run(
        params.id,
        params.id,
        params.status,
        params.expectedBytes ?? 5,
        expiresAt,
        deleteAfter,
        updatedAt,
        updatedAt
      );
    main
      .prepare(
        `INSERT INTO diagnostic_artifacts
         (id, incident_id, node_id, kind, status, object_key, content_type, checksum_sha256,
          expected_bytes, actual_bytes, expires_at, created_at, updated_at)
         VALUES (?, ?, 'node-1', 'safe-vm-incident-v1', ?, ?, 'application/gzip', ?, ?, ?, ?, ?, ?)`
      )
      .run(
        `${params.id}-safe`,
        params.id,
        params.artifactStatus,
        params.objectKey,
        params.checksum ?? 'a'.repeat(64),
        params.expectedBytes ?? 5,
        params.artifactStatus === 'available' ? (params.expectedBytes ?? 5) : null,
        expiresAt,
        updatedAt,
        updatedAt
      );
  }

  it('repairs completed stale uploads and fails missing or drifted artifacts', async () => {
    insertIncident({
      id: '01KZ8V0GMXQ4ZCSERPRT2X2K6V',
      status: 'pending',
      artifactStatus: 'pending',
      objectKey: 'repair',
    });
    insertIncident({
      id: '01KZ8V0GMXQ4ZCSERPRT2X2K6W',
      status: 'pending',
      artifactStatus: 'pending',
      objectKey: 'missing-pending',
    });
    insertIncident({
      id: '01KZ8V0GMXQ4ZCSERPRT2X2K6X',
      status: 'available',
      artifactStatus: 'available',
      objectKey: 'missing-available',
      updatedAt: '2026-08-05T12:00:00.000Z',
    });
    r2.heads.set('repair', {
      size: 5,
      customMetadata: { checksumSha256: 'a'.repeat(64) },
    });

    const result = await reconcileDiagnosticIncidents(env);
    // The repaired pending row is deliberately verified once more in the
    // available-object drift pass during the same bounded sweep.
    expect(result).toMatchObject({ checked: 4, repaired: 1, failed: 2 });
    expect(main.prepare('SELECT id, status FROM diagnostic_incidents ORDER BY id').all()).toEqual([
      { id: '01KZ8V0GMXQ4ZCSERPRT2X2K6V', status: 'available' },
      { id: '01KZ8V0GMXQ4ZCSERPRT2X2K6W', status: 'failed' },
      { id: '01KZ8V0GMXQ4ZCSERPRT2X2K6X', status: 'failed' },
    ]);
  });

  it('expires R2 content, deletes aged metadata explicitly, and repairs primary-D1 gaps', async () => {
    const expiredId = '01KZ8V0GMXQ4ZCSERPRT2X2K6Y';
    const deletedId = '01KZ8V0GMXQ4ZCSERPRT2X2K6Z';
    insertIncident({
      id: expiredId,
      status: 'available',
      artifactStatus: 'available',
      objectKey: 'expired-object',
      expiresAt: '2020-01-01T00:00:00.000Z',
    });
    insertIncident({
      id: deletedId,
      status: 'expired',
      artifactStatus: 'expired',
      objectKey: 'delete-object',
      expiresAt: '2020-01-01T00:00:00.000Z',
      deleteAfter: '2020-02-01T00:00:00.000Z',
    });
    r2.heads.set('expired-object', { size: 5 });
    r2.heads.set('delete-object', { size: 5 });
    const repairId = '01KZ8V0GMXQ4ZCSERPRT2X2K70';
    observability
      .prepare(
        `INSERT INTO platform_errors
         (id, source, level, message, node_id, workspace_id, timestamp, created_at)
         VALUES (?, 'vm-agent', 'error', 'original exact failure', 'node-1', 'workspace-1', ?, ?)`
      )
      .run(repairId, Date.now(), Date.now());

    const result = await reconcileDiagnosticIncidents(env);
    expect(result.expired).toBe(1);
    expect(result.deleted).toBe(1);
    expect(result.incidentMetadataRepaired).toBe(1);
    expect(
      main
        .prepare('SELECT preview_json, status FROM diagnostic_incidents WHERE id = ?')
        .get(expiredId)
    ).toEqual({ preview_json: null, status: 'expired' });
    expect(
      main.prepare('SELECT id FROM diagnostic_incidents WHERE id = ?').get(deletedId)
    ).toBeUndefined();
    expect(
      main
        .prepare(
          'SELECT platform_error_id, node_id, workspace_id, status FROM diagnostic_incidents WHERE id = ?'
        )
        .get(repairId)
    ).toEqual({
      platform_error_id: repairId,
      node_id: 'node-1',
      workspace_id: 'workspace-1',
      status: 'pending',
    });
    expect(
      observability.prepare('SELECT message FROM platform_errors WHERE id = ?').get(repairId)
    ).toEqual({ message: 'original exact failure' });
    expect(r2.heads.size).toBe(0);
  });
});
