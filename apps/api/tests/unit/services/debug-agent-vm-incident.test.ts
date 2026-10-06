import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import migrationSql from '../../../src/db/migrations/0106_diagnostic_incidents.sql?raw';
import type { Env } from '../../../src/env';
import {
  executeTool,
  resolveDebugAgentConfig,
  type ToolCall,
} from '../../../src/services/debug-agent';
import { diagnosticDedupSchemaSql } from '../../helpers/diagnostic-dedup-schema';
import {
  diagnosticSecretCanaries,
  expectDiagnosticCanariesAbsent,
} from '../../helpers/diagnostic-secret-canaries';
import { createSqliteD1 } from '../../helpers/sqlite-d1';

const INCIDENT_ID = '01KZ8V0GMXQ4ZCSERPRT2X2K6T';

function toolCall(): ToolCall {
  return {
    id: 'call-vm-incident',
    type: 'function',
    function: { name: 'get_vm_incident', arguments: '{}' },
  };
}

describe('get_vm_incident diagnosis tool', () => {
  it('returns only bounded redacted summary data without R2 coordinates or raw bytes', async () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(migrationSql);
    sqlite.exec(diagnosticDedupSchemaSql);
    sqlite
      .prepare(
        `INSERT INTO diagnostic_incidents
         (id, platform_error_id, node_id, status, artifact_count, total_bytes,
          manifest_json, preview_json, expires_at, delete_after)
         VALUES (?, ?, 'node-1', 'available', 1, 5, ?, ?, datetime('now', '+7 days'),
                 datetime('now', '+30 days'))`
      )
      .run(
        INCIDENT_ID,
        INCIDENT_ID,
        JSON.stringify({
          version: 1,
          incidentId: INCIDENT_ID,
          nodeId: 'node-1',
          source: 'session-host',
          createdAt: '2026-08-05T12:00:00.000Z',
          collectors: [],
          totalBytes: 5,
          redactions: 0,
          anyTruncated: false,
        }),
        JSON.stringify({
          health: 'degraded',
          nested: {
            authorization: diagnosticSecretCanaries.join(' '),
            details: diagnosticSecretCanaries,
          },
        })
      );
    sqlite
      .prepare(
        `INSERT INTO diagnostic_artifacts
         (id, incident_id, node_id, kind, status, object_key, content_type,
          checksum_sha256, expected_bytes, actual_bytes, expires_at)
         VALUES (?, ?, 'node-1', 'safe-vm-incident-v1', 'available', ?,
                 'application/gzip', ?, 5, 5, datetime('now', '+7 days'))`
      )
      .run(
        `${INCIDENT_ID}-safe`,
        INCIDENT_ID,
        `diagnostic-incidents/node-1/${INCIDENT_ID}/private-object.tar.gz`,
        'a'.repeat(64)
      );
    const env = {
      DATABASE: createSqliteD1(sqlite),
    } as Env;

    const result = await executeTool(
      env,
      { errorId: INCIDENT_ID, startMs: 0, endMs: 1 },
      resolveDebugAgentConfig(env),
      toolCall()
    );

    expect(result).toContain('"status":"available"');
    expect(result).toContain('"health":"degraded"');
    expect(result).toContain('[REDACTED]');
    expectDiagnosticCanariesAbsent(result);
    expect(result).not.toContain('private-object');
    expect(result).not.toContain('object_key');
    expect(result).not.toContain('https://');
  });

  it('reports explicit missing and window-only states', async () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(migrationSql);
    sqlite.exec(diagnosticDedupSchemaSql);
    const env = { DATABASE: createSqliteD1(sqlite) } as Env;
    const config = resolveDebugAgentConfig(env);

    expect(
      await executeTool(env, { errorId: INCIDENT_ID, startMs: 0, endMs: 1 }, config, toolCall())
    ).toContain('"status":"missing"');
    expect(
      await executeTool(env, { errorId: null, startMs: 0, endMs: 1 }, config, toolCall())
    ).toContain('"status":"unavailable"');
  });
});
