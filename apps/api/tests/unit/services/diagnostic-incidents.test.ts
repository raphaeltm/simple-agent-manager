import { createHash } from 'node:crypto';

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import migrationSql from '../../../src/db/migrations/0106_diagnostic_incidents.sql?raw';
import type { Env } from '../../../src/env';
import {
  ensurePendingIncidents,
  getDiagnosticIncidentByErrorId,
  registerDiagnosticArtifact,
  uploadDiagnosticArtifact,
} from '../../../src/services/diagnostic-incidents';
import { createSqliteD1 } from '../../helpers/sqlite-d1';

const INCIDENT_ID = '01KZ8V0GMXQ4ZCSERPRT2X2K6M';
const ERROR_ID = INCIDENT_ID;
const ARTIFACT_ID = `${INCIDENT_ID}-safe`;
const NODE_ID = 'node-1';

class MemoryR2 {
  readonly objects = new Map<string, Uint8Array>();
  readonly put = vi.fn(
    async (key: string, value: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array) => {
      const bytes =
        value instanceof ReadableStream
          ? new Uint8Array(await new Response(value).arrayBuffer())
          : value instanceof ArrayBuffer
            ? new Uint8Array(value)
            : value;
      this.objects.set(key, bytes);
      return {} as R2Object;
    }
  );
  readonly delete = vi.fn(async (key: string) => {
    this.objects.delete(key);
  });
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function registration(bytes: Uint8Array) {
  return {
    artifactId: ARTIFACT_ID,
    kind: 'safe-vm-incident-v1',
    contentType: 'application/gzip',
    sizeBytes: bytes.byteLength,
    checksumSha256: sha256(bytes),
    manifest: {
      version: 1,
      incidentId: INCIDENT_ID,
      nodeId: NODE_ID,
      source: 'session-host',
      createdAt: '2026-08-05T12:00:00.000Z',
      collectors: [],
      totalBytes: 0,
      redactions: 1,
      anyTruncated: false,
    },
    preview: { health: { status: 'degraded' } },
    status: 'ready' as const,
  };
}

describe('diagnostic incident storage boundary', () => {
  let sqlite: Database.Database;
  let r2: MemoryR2;
  let env: Env;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(migrationSql);
    r2 = new MemoryR2();
    env = {
      DATABASE: createSqliteD1(sqlite),
      R2: r2 as unknown as R2Bucket,
    } as Env;
  });

  async function seedIncident(nodeId = NODE_ID) {
    await ensurePendingIncidents(env, [
      {
        incidentId: INCIDENT_ID,
        platformErrorId: ERROR_ID,
        nodeId,
        workspaceId: 'workspace-1',
      },
    ]);
  }

  it('registers, streams, verifies, stores privately, and summarizes an artifact', async () => {
    const bytes = new TextEncoder().encode('bounded-safe-archive');
    await seedIncident();
    const first = await registerDiagnosticArtifact(env, NODE_ID, INCIDENT_ID, registration(bytes));
    const duplicate = await registerDiagnosticArtifact(
      env,
      NODE_ID,
      INCIDENT_ID,
      registration(bytes)
    );
    expect(first).toEqual({ artifactId: ARTIFACT_ID, status: 'pending' });
    expect(duplicate).toEqual(first);

    await uploadDiagnosticArtifact(
      env,
      NODE_ID,
      INCIDENT_ID,
      ARTIFACT_ID,
      new Request('https://api.example.test/content', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/gzip',
          'Content-Length': String(bytes.byteLength),
          'X-Content-SHA256': sha256(bytes),
        },
        body: bytes,
      })
    );
    await uploadDiagnosticArtifact(
      env,
      NODE_ID,
      INCIDENT_ID,
      ARTIFACT_ID,
      new Request('https://api.example.test/content', { method: 'PUT' })
    );

    expect(r2.put).toHaveBeenCalledTimes(1);
    const [key] = r2.put.mock.calls[0]!;
    expect(key).toBe(`diagnostic-incidents/${NODE_ID}/${INCIDENT_ID}/${ARTIFACT_ID}.tar.gz`);
    expect(key).not.toContain('http');
    expect(r2.objects.get(key)).toEqual(bytes);
    expect(await getDiagnosticIncidentByErrorId(env, ERROR_ID)).toMatchObject({
      id: INCIDENT_ID,
      status: 'available',
      totalBytes: bytes.byteLength,
      preview: { health: { status: 'degraded' } },
      artifacts: [{ id: ARTIFACT_ID, status: 'available', sizeBytes: bytes.byteLength }],
    });
  });

  it('rejects another node and conflicting duplicate metadata', async () => {
    const bytes = new TextEncoder().encode('safe');
    await seedIncident();
    await expect(
      registerDiagnosticArtifact(env, 'node-2', INCIDENT_ID, registration(bytes))
    ).rejects.toMatchObject({ statusCode: 403 });
    await registerDiagnosticArtifact(env, NODE_ID, INCIDENT_ID, registration(bytes));
    await expect(
      registerDiagnosticArtifact(env, NODE_ID, INCIDENT_ID, {
        ...registration(bytes),
        checksumSha256: 'a'.repeat(64),
      })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('deletes checksum-mismatched content and keeps the upload retryable', async () => {
    const registered = new TextEncoder().encode('expected');
    const corrupted = new TextEncoder().encode('corrupt!');
    await seedIncident();
    await registerDiagnosticArtifact(env, NODE_ID, INCIDENT_ID, registration(registered));

    await expect(
      uploadDiagnosticArtifact(
        env,
        NODE_ID,
        INCIDENT_ID,
        ARTIFACT_ID,
        new Request('https://api.example.test/content', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/gzip',
            'Content-Length': String(corrupted.byteLength),
            'X-Content-SHA256': sha256(registered),
          },
          body: corrupted,
        })
      )
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(r2.objects.size).toBe(0);
    expect(
      sqlite
        .prepare('SELECT status, upload_attempts, failure_reason FROM diagnostic_artifacts')
        .get()
    ).toEqual({ status: 'pending', upload_attempts: 1, failure_reason: 'Checksum mismatch' });
  });

  it('enforces registration, artifact-byte, and per-node quotas', async () => {
    const bytes = new TextEncoder().encode('12345');
    await seedIncident();
    await expect(
      registerDiagnosticArtifact(
        { ...env, VM_INCIDENT_ARTIFACT_MAX_BYTES: '4' } as Env,
        NODE_ID,
        INCIDENT_ID,
        registration(bytes)
      )
    ).rejects.toMatchObject({ statusCode: 400 });

    await expect(
      registerDiagnosticArtifact(
        { ...env, VM_INCIDENT_MAX_ARTIFACTS_PER_NODE: '1' } as Env,
        NODE_ID,
        INCIDENT_ID,
        {
          ...registration(bytes),
          preview: { data: 'x'.repeat(200) },
        }
      )
    ).resolves.toMatchObject({ status: 'pending' });

    const secondIncident = '01KZ8V0GMXQ4ZCSERPRT2X2K6N';
    await ensurePendingIncidents(env, [
      {
        incidentId: secondIncident,
        platformErrorId: secondIncident,
        nodeId: NODE_ID,
        workspaceId: null,
      },
    ]);
    await expect(
      registerDiagnosticArtifact(
        { ...env, VM_INCIDENT_MAX_ARTIFACTS_PER_NODE: '1' } as Env,
        NODE_ID,
        secondIncident,
        {
          ...registration(bytes),
          artifactId: `${secondIncident}-safe`,
          manifest: { ...registration(bytes).manifest, incidentId: secondIncident },
        }
      )
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});
