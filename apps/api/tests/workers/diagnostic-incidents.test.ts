import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

import { signCallbackToken, signNodeCallbackToken } from '../../src/services/jwt';

const NODE_ID = 'diagnostic-worker-node';
const WORKSPACE_ID = 'diagnostic-worker-workspace';
const INCIDENT_ID = '01KZ8V0GMXQ4ZCSERPRT2X2K6P';
const ARTIFACT_ID = `${INCIDENT_ID}-safe`;
let nodeToken: string;
let otherNodeToken: string;
let workspaceToken: string;

async function checksum(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

beforeAll(async () => {
  nodeToken = await signNodeCallbackToken(NODE_ID, env as never);
  otherNodeToken = await signNodeCallbackToken('diagnostic-other-node', env as never);
  workspaceToken = await signCallbackToken(WORKSPACE_ID, env as never);
});

describe('same-instance automatic VM incident contract', () => {
  it('requires a matching node callback token for artifact registration', async () => {
    const url = `https://api.test.example.com/api/nodes/${NODE_ID}/diagnostic-incidents/${INCIDENT_ID}/artifacts`;
    const body = JSON.stringify({});
    const missing = await SELF.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const workspace = await SELF.fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${workspaceToken}`,
        'Content-Type': 'application/json',
      },
      body,
    });
    expect(missing.status).toBe(401);
    expect(workspace.status).toBe(403);
  });

  it('durably correlates the error, streams private R2 content, and deduplicates retries', async () => {
    const report = await SELF.fetch(`https://api.test.example.com/api/nodes/${NODE_ID}/errors`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${nodeToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        errors: [
          {
            incidentId: INCIDENT_ID,
            message: 'safe fault injection',
            source: 'worker-contract-test',
            level: 'error',
            workspaceId: WORKSPACE_ID,
            timestamp: '2026-08-05T12:00:00.000Z',
          },
        ],
      }),
    });
    expect(report.status).toBe(204);
    expect(
      await env.OBSERVABILITY_DATABASE.prepare(
        'SELECT source, node_id FROM platform_errors WHERE id = ?'
      )
        .bind(INCIDENT_ID)
        .first()
    ).toMatchObject({ source: 'vm-agent', node_id: NODE_ID });
    expect(
      await env.DATABASE.prepare(
        'SELECT status, node_id, platform_error_id FROM diagnostic_incidents WHERE id = ?'
      )
        .bind(INCIDENT_ID)
        .first()
    ).toMatchObject({ status: 'pending', node_id: NODE_ID, platform_error_id: INCIDENT_ID });

    const bytes = new TextEncoder().encode('bounded-gzip-placeholder');
    const digest = await checksum(bytes);
    const registrationBody = JSON.stringify({
      artifactId: ARTIFACT_ID,
      kind: 'safe-vm-incident-v1',
      contentType: 'application/gzip',
      sizeBytes: bytes.byteLength,
      checksumSha256: digest,
      manifest: {
        version: 1,
        incidentId: INCIDENT_ID,
        nodeId: NODE_ID,
        source: 'worker-contract-test',
        createdAt: '2026-08-05T12:00:00.000Z',
        collectors: [],
        totalBytes: 0,
        redactions: 0,
        anyTruncated: false,
      },
      preview: { health: 'degraded' },
      status: 'ready',
    });
    const registerUrl = `https://api.test.example.com/api/nodes/${NODE_ID}/diagnostic-incidents/${INCIDENT_ID}/artifacts`;
    const registration = await SELF.fetch(registerUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${nodeToken}`,
        'Content-Type': 'application/json',
      },
      body: registrationBody,
    });
    expect(registration.status).toBe(201);

    const otherNode = await SELF.fetch(
      `https://api.test.example.com/api/nodes/diagnostic-other-node/diagnostic-incidents/${INCIDENT_ID}/artifacts`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${otherNodeToken}`,
          'Content-Type': 'application/json',
        },
        body: registrationBody,
      }
    );
    expect(otherNode.status).toBe(403);

    const uploadUrl = `${registerUrl}/${ARTIFACT_ID}/content`;
    const upload = await SELF.fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${nodeToken}`,
        'Content-Type': 'application/gzip',
        'Content-Length': String(bytes.byteLength),
        'X-Content-SHA256': digest,
      },
      body: bytes,
    });
    expect(upload.status).toBe(204);
    const duplicate = await SELF.fetch(uploadUrl, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${nodeToken}` },
    });
    expect(duplicate.status).toBe(204);

    const objectKey = `diagnostic-incidents/${NODE_ID}/${INCIDENT_ID}/${ARTIFACT_ID}.tar.gz`;
    expect(new Uint8Array(await (await env.R2.get(objectKey))!.arrayBuffer())).toEqual(bytes);
    expect(
      await env.DATABASE.prepare(
        'SELECT status, total_bytes FROM diagnostic_incidents WHERE id = ?'
      )
        .bind(INCIDENT_ID)
        .first()
    ).toMatchObject({ status: 'available', total_bytes: bytes.byteLength });
  });
});
