import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import migrationSql from '../../../src/db/migrations/0106_diagnostic_incidents.sql?raw';
import expiryIndexMigrationSql from '../../../src/db/migrations/0107_diagnostic_artifact_expiry_index.sql?raw';
import statusOrderMigrationSql from '../../../src/db/migrations/0108_diagnostic_reconciliation_status_order.sql?raw';
import type { Env } from '../../../src/env';
import { reconcileDiagnosticIncidents } from '../../../src/services/diagnostic-incident-reconciliation';
import { createSqliteD1 } from '../../helpers/sqlite-d1';

interface Head {
  size: number;
  checksums?: { sha256: ArrayBuffer };
}

function checksumBytes(hex: string): ArrayBuffer {
  return Uint8Array.from(Buffer.from(hex, 'hex')).buffer;
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
    main.exec(expiryIndexMigrationSql);
    main.exec(statusOrderMigrationSql);
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

  it('uses the bounded partial expiry index rather than scanning retained history', () => {
    const plan = main
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT id FROM diagnostic_artifacts
         WHERE status <> 'expired' AND expires_at <= ?
         ORDER BY expires_at ASC LIMIT ?`
      )
      .all('2026-08-06T20:00:00.000Z', 20) as Array<{ detail: string }>;

    expect(
      plan.some((step) => step.detail.includes('idx_diagnostic_artifacts_pending_expiry'))
    ).toBe(true);
    expect(plan.some((step) => step.detail.includes('USE TEMP B-TREE'))).toBe(false);
  });

  it('uses the status-order index for bounded reconciliation scans', () => {
    const plan = main
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT id, incident_id, node_id, status, object_key, checksum_sha256, expected_bytes
         FROM diagnostic_artifacts
         WHERE status = 'pending' AND datetime(updated_at) < datetime(?)
           AND (upload_lease_id IS NULL OR datetime(upload_lease_expires_at) <= datetime(?))
         ORDER BY datetime(updated_at) ASC, id ASC LIMIT ?`
      )
      .all('2026-08-06T20:00:00.000Z', '2026-08-06T20:00:00.000Z', 20) as Array<{
      detail: string;
    }>;

    expect(
      plan.some((step) => step.detail.includes('idx_diagnostic_artifacts_status_updated'))
    ).toBe(true);
    expect(plan.some((step) => step.detail.includes('<expr><?'))).toBe(true);
    expect(plan.some((step) => step.detail.includes('USE TEMP B-TREE'))).toBe(false);
  });

  it('uses the status-order index without sorting the available-object scan', () => {
    const plan = main
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT id, incident_id, node_id, status, object_key, checksum_sha256, expected_bytes
         FROM diagnostic_artifacts
         WHERE status = 'available' ORDER BY datetime(updated_at) ASC, id ASC LIMIT ?`
      )
      .all(20) as Array<{ detail: string }>;

    expect(
      plan.some((step) => step.detail.includes('idx_diagnostic_artifacts_status_updated'))
    ).toBe(true);
    expect(plan.some((step) => step.detail.includes('USE TEMP B-TREE'))).toBe(false);
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
      checksums: { sha256: checksumBytes('a'.repeat(64)) },
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

  it('fails stale pending incidents whose artifact registration never completed', async () => {
    const id = '01KZ8V0GMXQ4ZCSERPRT2X2K85';
    main
      .prepare(
        `INSERT INTO diagnostic_incidents
         (id, platform_error_id, node_id, status, artifact_count, total_bytes,
          expires_at, delete_after, created_at, updated_at)
         VALUES (?, ?, 'node-1', 'pending', 0, 0,
                 '2099-01-01T00:00:00.000Z', '2099-02-01T00:00:00.000Z',
                 '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')`
      )
      .run(id, id);

    const result = await reconcileDiagnosticIncidents(env);

    expect(result.failed).toBe(1);
    expect(
      main.prepare('SELECT status, failure_reason FROM diagnostic_incidents WHERE id = ?').get(id)
    ).toEqual({
      status: 'failed',
      failure_reason: 'Artifact registration did not complete before the pending deadline',
    });
    expect(main.prepare('SELECT COUNT(*) AS count FROM diagnostic_artifacts').get()).toEqual({
      count: 0,
    });
  });

  it('expires and deletes retained incidents even when registration never created an artifact', async () => {
    const id = '01KZ8V0GMXQ4ZCSERPRT2X2K86';
    main
      .prepare(
        `INSERT INTO diagnostic_incidents
         (id, platform_error_id, node_id, status, artifact_count, total_bytes, preview_json,
          expires_at, delete_after, created_at, updated_at)
         VALUES (?, ?, 'node-1', 'failed', 0, 0, '{"safe":true}',
                 '2020-01-01T00:00:00.000Z', '2099-02-01T00:00:00.000Z',
                 '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')`
      )
      .run(id, id);

    const expired = await reconcileDiagnosticIncidents(env);

    expect(expired.expired).toBe(1);
    expect(
      main.prepare('SELECT status, preview_json FROM diagnostic_incidents WHERE id = ?').get(id)
    ).toEqual({ status: 'expired', preview_json: null });

    main
      .prepare(
        "UPDATE diagnostic_incidents SET delete_after = '2020-02-01T00:00:00.000Z' WHERE id = ?"
      )
      .run(id);
    const deleted = await reconcileDiagnosticIncidents(env);
    expect(deleted.deleted).toBe(1);
    expect(
      main.prepare('SELECT id FROM diagnostic_incidents WHERE id = ?').get(id)
    ).toBeUndefined();
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

  it('never promotes same-size content whose native R2 checksum differs', async () => {
    const id = '01KZ8V0GMXQ4ZCSERPRT2X2K71';
    insertIncident({
      id,
      status: 'pending',
      artifactStatus: 'pending',
      objectKey: 'corrupt-after-put',
    });
    r2.heads.set('corrupt-after-put', {
      size: 5,
      checksums: { sha256: checksumBytes('b'.repeat(64)) },
    });
    const result = await reconcileDiagnosticIncidents(env);
    expect(result).toMatchObject({ repaired: 0, failed: 1 });
    expect(main.prepare('SELECT status FROM diagnostic_incidents WHERE id = ?').get(id)).toEqual({
      status: 'failed',
    });
    expect(r2.heads.has('corrupt-after-put')).toBe(true);
    expect(r2.delete).not.toHaveBeenCalledWith('corrupt-after-put');
  });

  it('leaves actively leased pending uploads untouched', async () => {
    const id = '01KZ8V0GMXQ4ZCSERPRT2X2K72';
    insertIncident({
      id,
      status: 'pending',
      artifactStatus: 'pending',
      objectKey: 'actively-uploading',
    });
    main
      .prepare(
        `UPDATE diagnostic_artifacts SET upload_lease_id = 'uploader',
         upload_lease_expires_at = '2099-01-01T00:00:00.000Z' WHERE incident_id = ?`
      )
      .run(id);

    const result = await reconcileDiagnosticIncidents(env);
    expect(result).toMatchObject({ checked: 0, repaired: 0, failed: 0 });
    expect(
      main.prepare('SELECT status FROM diagnostic_artifacts WHERE incident_id = ?').get(id)
    ).toEqual({
      status: 'pending',
    });
    expect(r2.head).not.toHaveBeenCalledWith('actively-uploading');
  });

  it('rotates available-object checks and advances the dual-D1 sweep across batches', async () => {
    const ids = Array.from({ length: 6 }, (_, index) => `01KZ8V0GMXQ4ZCSERPRT2X2K7${index + 2}`);
    for (const [index, id] of ids.entries()) {
      const objectKey = `available-${index}`;
      insertIncident({
        id,
        status: 'available',
        artifactStatus: 'available',
        objectKey,
      });
      if (index < ids.length - 1) {
        r2.heads.set(objectKey, {
          size: 5,
          checksums: { sha256: checksumBytes('a'.repeat(64)) },
        });
      }
      observability
        .prepare(
          `INSERT INTO platform_errors
           (id, source, level, message, node_id, workspace_id, timestamp, created_at)
           VALUES (?, 'vm-agent', 'error', 'exact failure', 'node-1', NULL, ?, ?)`
        )
        .run(id, index + 1, index + 1);
    }

    const first = await reconcileDiagnosticIncidents(env);
    expect(first.failed).toBe(0);
    expect(first.incidentMetadataRepaired).toBe(0);
    const second = await reconcileDiagnosticIncidents(env);
    expect(second.failed).toBe(1);

    main.prepare('DELETE FROM diagnostic_artifacts').run();
    main.prepare('DELETE FROM diagnostic_incidents').run();
    main.prepare('DELETE FROM diagnostic_reconciliation_state').run();
    const metadataFirst = await reconcileDiagnosticIncidents(env);
    const metadataSecond = await reconcileDiagnosticIncidents(env);
    const metadataThird = await reconcileDiagnosticIncidents(env);
    expect(
      metadataFirst.incidentMetadataRepaired +
        metadataSecond.incidentMetadataRepaired +
        metadataThird.incidentMetadataRepaired
    ).toBe(ids.length);
    expect(main.prepare('SELECT COUNT(*) AS count FROM diagnostic_incidents').get()).toEqual({
      count: ids.length,
    });
  });

  it('funds every reconciliation phase when configuration is below the six-phase minimum', async () => {
    env.VM_INCIDENT_RECONCILE_BATCH_SIZE = '1';
    insertIncident({
      id: '01KZ8V0GMXQ4ZCSERPRT2X2K80',
      status: 'pending',
      artifactStatus: 'pending',
      objectKey: 'minimum-pending',
    });
    insertIncident({
      id: '01KZ8V0GMXQ4ZCSERPRT2X2K81',
      status: 'available',
      artifactStatus: 'available',
      objectKey: 'minimum-expired',
      expiresAt: '2020-01-01T00:00:00.000Z',
    });
    insertIncident({
      id: '01KZ8V0GMXQ4ZCSERPRT2X2K82',
      status: 'expired',
      artifactStatus: 'expired',
      objectKey: 'minimum-delete',
      expiresAt: '2020-01-01T00:00:00.000Z',
      deleteAfter: '2020-02-01T00:00:00.000Z',
    });
    insertIncident({
      id: '01KZ8V0GMXQ4ZCSERPRT2X2K83',
      status: 'available',
      artifactStatus: 'available',
      objectKey: 'minimum-missing-available',
      updatedAt: '2026-08-05T12:00:00.000Z',
    });
    const repairId = '01KZ8V0GMXQ4ZCSERPRT2X2K84';
    observability
      .prepare(
        `INSERT INTO platform_errors
         (id, source, level, message, node_id, workspace_id, timestamp, created_at)
         VALUES (?, 'vm-agent', 'error', 'repair me', 'node-1', NULL, 1, 1)`
      )
      .run(repairId);

    const result = await reconcileDiagnosticIncidents(env);
    expect(result).toMatchObject({
      failed: 2,
      expired: 1,
      deleted: 1,
      incidentMetadataRepaired: 1,
    });
  });
});
