import { createHash } from 'node:crypto';

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import migrationSql from '../../../src/db/migrations/0106_diagnostic_incidents.sql?raw';
import type { Env } from '../../../src/env';
import {
  DEFAULT_VM_INCIDENT_R2_PREFIX,
  resolveDiagnosticIncidentConfig,
} from '../../../src/services/diagnostic-incident-config';
import {
  diagnosticIncidentSignature,
  ensurePendingIncidents,
  getDiagnosticIncidentByErrorId,
  getDiagnosticIncidentsByErrorIds,
  getDiagnosticIncidentsByNodeId,
  registerDiagnosticArtifact,
  uploadDiagnosticArtifact,
} from '../../../src/services/diagnostic-incidents';
import { diagnosticDedupSchemaSql } from '../../helpers/diagnostic-dedup-schema';
import { createSqliteD1 } from '../../helpers/sqlite-d1';

const INCIDENT_ID = '01KZ8V0GMXQ4ZCSERPRT2X2K6M';
const ERROR_ID = INCIDENT_ID;
const ARTIFACT_ID = `${INCIDENT_ID}-safe`;
const NODE_ID = 'node-1';
const TEST_ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function testUlid(index: number): string {
  let value = index;
  let suffix = '';
  for (let position = 0; position < 4; position++) {
    suffix = TEST_ULID_ALPHABET[value % TEST_ULID_ALPHABET.length] + suffix;
    value = Math.floor(value / TEST_ULID_ALPHABET.length);
  }
  return `01KZ8V0GMXQ4ZCSERPRT2X${suffix}`;
}

it.each([
  'agents/private-incidents',
  'cli/private-incidents',
  'compose-image-artifacts/private-incidents',
  'library/private-incidents',
  'session-snapshots/private-incidents',
  'temp-uploads/private-incidents',
  'tts/private-incidents',
])('rejects reserved runtime R2 prefix %s', (prefix) => {
  expect(resolveDiagnosticIncidentConfig({ VM_INCIDENT_R2_PREFIX: prefix } as Env).r2Prefix).toBe(
    DEFAULT_VM_INCIDENT_R2_PREFIX
  );
});

class MemoryR2 {
  readonly objects = new Map<string, Uint8Array>();
  readonly put = vi.fn(
    async (
      key: string,
      value: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array,
      options?: R2PutOptions
    ) => {
      const bytes =
        value instanceof ReadableStream
          ? new Uint8Array(await new Response(value).arrayBuffer())
          : value instanceof ArrayBuffer
            ? new Uint8Array(value)
            : value;
      const actual = sha256(bytes);
      if (typeof options?.sha256 === 'string' && options.sha256 !== actual) {
        throw new Error('R2 SHA-256 mismatch');
      }
      this.objects.set(key, bytes);
      return {} as R2Object;
    }
  );
  readonly delete = vi.fn(async (key: string) => {
    this.objects.delete(key);
  });
  readonly head = vi.fn(async (key: string) => {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    return {
      size: bytes.byteLength,
      checksums: { sha256: Uint8Array.from(Buffer.from(sha256(bytes), 'hex')).buffer },
    } as R2Object;
  });
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function registration(bytes: Uint8Array, incidentId = INCIDENT_ID, nodeId = NODE_ID) {
  return {
    artifactId: `${incidentId}-safe`,
    kind: 'safe-vm-incident-v1',
    contentType: 'application/gzip',
    sizeBytes: bytes.byteLength,
    checksumSha256: sha256(bytes),
    manifest: {
      version: 1,
      incidentId,
      nodeId,
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
    sqlite.exec(diagnosticDedupSchemaSql);
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

  it('deduplicates repeated incidents per signature and deployment while preserving frequency', async () => {
    const at = Date.parse('2026-08-25T12:00:00.000Z');
    const ids = Array.from({ length: 100 }, (_, index) => testUlid(index));
    const signature = await diagnosticIncidentSignature(
      'vm-agent',
      'snapshot failed because the devcontainer workspace is stopped'
    );
    const results = await ensurePendingIncidents(
      env,
      ids.map((id, index) => ({
        incidentId: id,
        platformErrorId: id,
        nodeId: `node-${index}`,
        workspaceId: `workspace-${index}`,
        signature,
        deploymentId: 'release-2026-08-25',
        occurredAt: at + index,
      }))
    );

    expect(results).toHaveLength(100);
    expect(results.filter((result) => result.duplicate)).toHaveLength(99);
    expect(results[0]).toMatchObject({
      incidentId: ids[0],
      canonicalIncidentId: ids[0],
      duplicate: false,
    });
    expect(results.at(-1)).toMatchObject({
      incidentId: ids[99],
      canonicalIncidentId: ids[0],
      duplicate: true,
      occurrenceRecorded: true,
    });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM diagnostic_incidents').get()).toEqual({
      count: 1,
    });
    expect(
      sqlite
        .prepare('SELECT id, occurrence_count, last_seen_at FROM diagnostic_incidents')
        .get()
    ).toEqual({
      id: ids[0],
      occurrence_count: 100,
      last_seen_at: new Date(at + 99).toISOString(),
    });
    expect(
      sqlite.prepare('SELECT COUNT(*) AS count FROM diagnostic_incident_occurrences').get()
    ).toEqual({ count: 99 });

    const bytes = new TextEncoder().encode('canonical-safe-archive');
    await registerDiagnosticArtifact(env, 'node-0', ids[0], registration(bytes, ids[0], 'node-0'));
    await uploadDiagnosticArtifact(
      env,
      'node-0',
      ids[0],
      `${ids[0]}-safe`,
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

    await expect(
      registerDiagnosticArtifact(env, 'node-99', ids[99], registration(bytes, ids[99], 'node-99'))
    ).resolves.toEqual({ artifactId: `${ids[99]}-safe`, status: 'available' });
    await expect(
      uploadDiagnosticArtifact(
        env,
        'node-99',
        ids[99],
        `${ids[99]}-safe`,
        new Request('https://api.example.test/content', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/gzip',
            'Content-Length': String(bytes.byteLength),
            'X-Content-SHA256': sha256(bytes),
          },
          body: bytes,
        })
      )
    ).resolves.toBeUndefined();

    expect(r2.put).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM diagnostic_artifacts').get()).toEqual({
      count: 1,
    });
    const duplicateSummary = await getDiagnosticIncidentByErrorId(env, ids[99]);
    expect(duplicateSummary).toMatchObject({
      id: ids[0],
      occurrenceCount: 100,
      lastSeenAt: new Date(at + 99).toISOString(),
      artifacts: [{ id: `${ids[0]}-safe`, status: 'available' }],
    });
    const byIds = await getDiagnosticIncidentsByErrorIds(env, [ids[0], ids[99]]);
    expect(byIds.get(ids[0])?.id).toBe(ids[0]);
    expect(byIds.get(ids[99])?.id).toBe(ids[0]);
  });

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
    const call = r2.put.mock.calls[0];
    if (!call) throw new Error('expected R2 upload');
    const [key] = call;
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

  it('degrades a manifest_json row missing the required shape to null without crashing', async () => {
    // Regression: parseJson<T> blindly cast row.manifest_json — the admin UI
    // reads manifest.collectors.length/.map(...) with no guard, so a row
    // missing `collectors` (or any other required manifest field) must
    // degrade the *field* to null server-side, not reach the client.
    const bytes = new TextEncoder().encode('safe');
    await seedIncident();
    await registerDiagnosticArtifact(env, NODE_ID, INCIDENT_ID, registration(bytes));

    sqlite
      .prepare(`UPDATE diagnostic_incidents SET manifest_json = ?, preview_json = ? WHERE id = ?`)
      .run(
        JSON.stringify({ incidentId: INCIDENT_ID, version: 1 }), // missing collectors, etc.
        JSON.stringify('just a string'), // valid JSON, not an object
        INCIDENT_ID
      );

    const incident = await getDiagnosticIncidentByErrorId(env, ERROR_ID);
    expect(incident).not.toBeNull();
    expect(incident?.id).toBe(INCIDENT_ID);
    expect(incident?.manifest).toBeNull();
    expect(incident?.preview).toBeNull();
  });

  it('degrades JSON-syntax-invalid manifest_json/preview_json to null without crashing', async () => {
    const bytes = new TextEncoder().encode('safe');
    await seedIncident();
    await registerDiagnosticArtifact(env, NODE_ID, INCIDENT_ID, registration(bytes));

    sqlite
      .prepare(`UPDATE diagnostic_incidents SET manifest_json = ?, preview_json = ? WHERE id = ?`)
      .run('{not valid json', '{not valid json', INCIDENT_ID);

    const incident = await getDiagnosticIncidentByErrorId(env, ERROR_ID);
    expect(incident?.manifest).toBeNull();
    expect(incident?.preview).toBeNull();
  });

  it('still parses a well-formed manifest_json/preview_json pair', async () => {
    const bytes = new TextEncoder().encode('safe');
    await seedIncident();
    const reg = registration(bytes);
    await registerDiagnosticArtifact(env, NODE_ID, INCIDENT_ID, reg);

    const incident = await getDiagnosticIncidentByErrorId(env, ERROR_ID);
    expect(incident?.manifest).toMatchObject({
      version: 1,
      incidentId: INCIDENT_ID,
      collectors: [],
    });
    expect(incident?.preview).toEqual({ health: { status: 'degraded' } });
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

  it('downgrades a still-pending registration when the VM loses its local artifact', async () => {
    const bytes = new TextEncoder().encode('safe');
    await seedIncident();
    await registerDiagnosticArtifact(env, NODE_ID, INCIDENT_ID, registration(bytes));
    await expect(
      registerDiagnosticArtifact(env, NODE_ID, INCIDENT_ID, {
        ...registration(bytes),
        sizeBytes: 0,
        checksumSha256: '',
        manifest: { version: 1, incidentId: INCIDENT_ID, unavailable: true },
        preview: {},
        status: 'failed',
      })
    ).resolves.toEqual({ artifactId: ARTIFACT_ID, status: 'failed' });
    expect(
      sqlite
        .prepare('SELECT status, checksum_sha256, expected_bytes FROM diagnostic_artifacts')
        .get()
    ).toEqual({ status: 'failed', checksum_sha256: null, expected_bytes: 0 });
    expect(sqlite.prepare('SELECT status FROM diagnostic_incidents').get()).toEqual({
      status: 'failed',
    });
  });

  it('does not let failed registration or another upload cross an active upload lease', async () => {
    const bytes = new TextEncoder().encode('safe');
    await seedIncident();
    await registerDiagnosticArtifact(env, NODE_ID, INCIDENT_ID, registration(bytes));
    sqlite
      .prepare(
        `UPDATE diagnostic_artifacts SET upload_lease_id = 'active-upload',
         upload_lease_expires_at = '2099-01-01T00:00:00.000Z' WHERE id = ?`
      )
      .run(ARTIFACT_ID);

    await expect(
      registerDiagnosticArtifact(env, NODE_ID, INCIDENT_ID, {
        ...registration(bytes),
        sizeBytes: 0,
        checksumSha256: '',
        manifest: { version: 1, incidentId: INCIDENT_ID, unavailable: true },
        preview: {},
        status: 'failed',
      })
    ).rejects.toMatchObject({ statusCode: 500 });
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
            'Content-Length': String(bytes.byteLength),
            'X-Content-SHA256': sha256(bytes),
          },
          body: bytes,
        })
      )
    ).rejects.toMatchObject({ statusCode: 500 });
    expect(r2.put).not.toHaveBeenCalled();
    expect(
      sqlite
        .prepare('SELECT status, upload_lease_id FROM diagnostic_artifacts WHERE id = ?')
        .get(ARTIFACT_ID)
    ).toEqual({ status: 'pending', upload_lease_id: 'active-upload' });
    expect(sqlite.prepare('SELECT status FROM diagnostic_incidents').get()).toEqual({
      status: 'pending',
    });
  });

  it('lets R2 atomically reject checksum-mismatched content and keeps the upload retryable', async () => {
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
    ).rejects.toThrow('R2 SHA-256 mismatch');
    expect(r2.objects.size).toBe(0);
    expect(
      sqlite
        .prepare('SELECT status, upload_attempts, failure_reason FROM diagnostic_artifacts')
        .get()
    ).toEqual({ status: 'pending', upload_attempts: 1, failure_reason: 'Upload failed' });
  });

  it('recovers a prior successful object when a retry loses its response', async () => {
    const bytes = new TextEncoder().encode('safe');
    await seedIncident();
    await registerDiagnosticArtifact(env, NODE_ID, INCIDENT_ID, registration(bytes));
    const key = `diagnostic-incidents/${NODE_ID}/${INCIDENT_ID}/${ARTIFACT_ID}.tar.gz`;
    r2.objects.set(key, bytes);
    r2.put.mockRejectedValueOnce(new Error('response connection dropped'));

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
            'Content-Length': String(bytes.byteLength),
            'X-Content-SHA256': sha256(bytes),
          },
          body: bytes,
        })
      )
    ).resolves.toBeUndefined();
    expect(r2.delete).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT status FROM diagnostic_artifacts').get()).toEqual({
      status: 'available',
    });
    expect(sqlite.prepare('SELECT status FROM diagnostic_incidents').get()).toEqual({
      status: 'available',
    });
  });

  it('rejects actual bytes beyond the registered length even with a forged header', async () => {
    const registered = new TextEncoder().encode('safe');
    const oversized = new TextEncoder().encode('safe-extra');
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
            'Content-Length': String(registered.byteLength),
            'X-Content-SHA256': sha256(registered),
          },
          body: oversized,
        })
      )
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(r2.objects.size).toBe(0);
  });

  it('redacts credential-shaped manifest and preview values again at ingestion', async () => {
    const bytes = new TextEncoder().encode('safe');
    const slackCanary = ['xoxb', '123456789012', 'abcdefghijklmnop'].join('-');
    await seedIncident();
    await registerDiagnosticArtifact(env, NODE_ID, INCIDENT_ID, {
      ...registration(bytes),
      manifest: {
        ...registration(bytes).manifest,
        neutral: 'AKIAIOSFODNN7EXAMPLE',
      },
      preview: {
        slack: slackCanary,
        url: 'https://operator:secret@example.test/path',
      },
    });
    const incident = await getDiagnosticIncidentByErrorId(env, ERROR_ID);
    const serialized = JSON.stringify(incident);
    expect(serialized).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(serialized).not.toContain(slackCanary);
    expect(serialized).not.toContain('operator:secret');
    expect(serialized).toContain('[REDACTED]');
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
    expect(
      sqlite
        .prepare(
          `SELECT status, artifact_count, manifest_json, preview_json
           FROM diagnostic_incidents WHERE id = ?`
        )
        .get(secondIncident)
    ).toEqual({
      status: 'pending',
      artifact_count: 0,
      manifest_json: null,
      preview_json: null,
    });

    const byteQuotaIncident = '01KZ8V0GMXQ4ZCSERPRT2X2K6P';
    await ensurePendingIncidents(env, [
      {
        incidentId: byteQuotaIncident,
        platformErrorId: byteQuotaIncident,
        nodeId: NODE_ID,
        workspaceId: null,
      },
    ]);
    await expect(
      registerDiagnosticArtifact(
        { ...env, VM_INCIDENT_MAX_BYTES_PER_NODE: String(bytes.byteLength) } as Env,
        NODE_ID,
        byteQuotaIncident,
        {
          ...registration(bytes),
          artifactId: `${byteQuotaIncident}-safe`,
          manifest: { ...registration(bytes).manifest, incidentId: byteQuotaIncident },
        }
      )
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('atomically admits only one concurrent registration at the per-node boundary', async () => {
    const bytes = new TextEncoder().encode('safe');
    const secondIncident = '01KZ8V0GMXQ4ZCSERPRT2X2K6N';
    await seedIncident();
    await ensurePendingIncidents(env, [
      {
        incidentId: secondIncident,
        platformErrorId: secondIncident,
        nodeId: NODE_ID,
        workspaceId: null,
      },
    ]);
    const limited = { ...env, VM_INCIDENT_MAX_ARTIFACTS_PER_NODE: '1' } as Env;
    const outcomes = await Promise.allSettled([
      registerDiagnosticArtifact(limited, NODE_ID, INCIDENT_ID, registration(bytes)),
      registerDiagnosticArtifact(limited, NODE_ID, secondIncident, {
        ...registration(bytes),
        artifactId: `${secondIncident}-safe`,
        manifest: { ...registration(bytes).manifest, incidentId: secondIncident },
      }),
    ]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM diagnostic_artifacts').get()).toEqual({
      count: 1,
    });
  });

  it('keeps incident evidence aligned with the winner of concurrent idempotent registration', async () => {
    const bytes = new TextEncoder().encode('safe');
    await seedIncident();
    const outcomes = await Promise.all([
      registerDiagnosticArtifact(env, NODE_ID, INCIDENT_ID, {
        ...registration(bytes),
        preview: { producer: 'first' },
      }),
      registerDiagnosticArtifact(env, NODE_ID, INCIDENT_ID, {
        ...registration(bytes),
        preview: { producer: 'second' },
      }),
    ]);
    expect(outcomes).toEqual([
      { artifactId: ARTIFACT_ID, status: 'pending' },
      { artifactId: ARTIFACT_ID, status: 'pending' },
    ]);

    const artifact = sqlite
      .prepare('SELECT manifest_json, preview_json FROM diagnostic_artifacts WHERE id = ?')
      .get(ARTIFACT_ID);
    const incident = sqlite
      .prepare('SELECT manifest_json, preview_json FROM diagnostic_incidents WHERE id = ?')
      .get(INCIDENT_ID);
    expect(incident).toEqual(artifact);
  });

  it('decorates a full 200-error page without exceeding D1 bind limits', async () => {
    const insert = sqlite.prepare(
      `INSERT INTO diagnostic_incidents
       (id, platform_error_id, node_id, status, expires_at, delete_after)
       VALUES (?, ?, ?, 'pending', '2099-01-01', '2099-02-01')`
    );
    const ids = Array.from({ length: 200 }, (_, index) => `incident-${index}`);
    sqlite.transaction(() => {
      for (const id of ids) insert.run(id, id, NODE_ID);
    })();
    const incidents = await getDiagnosticIncidentsByErrorIds(env, ids);
    expect(incidents.size).toBe(200);
    expect(incidents.get('incident-199')).toMatchObject({ platformErrorId: 'incident-199' });
  });

  it('lists node incidents and artifact status without joining a live node row', async () => {
    const bytes = new TextEncoder().encode('safe');
    await seedIncident('destroyed-node');
    await registerDiagnosticArtifact(env, 'destroyed-node', INCIDENT_ID, registration(bytes));

    const incidents = await getDiagnosticIncidentsByNodeId(env, 'destroyed-node', 10);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      id: INCIDENT_ID,
      nodeId: 'destroyed-node',
      status: 'pending',
      artifacts: [{ id: ARTIFACT_ID, status: 'pending' }],
    });
  });
});
