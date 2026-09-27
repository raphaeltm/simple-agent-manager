/**
 * VM agent error intake is the persisted-log path for agent output: whatever a crashed agent
 * printed lands in `platform_errors` and the admin error views. This drives the real route, the
 * real `redactSensitiveData`, and the real `persistErrorBatch` against a real SQLite database, then
 * reads back what was actually stored. Only callback JWT auth and the incident R2/metadata service
 * are stubbed.
 */
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { platformErrors } from '../../../src/db/observability-schema';
import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import {
  allCredentialTokenCanaries,
  credentialTokenCanaries,
  expectCredentialTokensAbsent,
} from '../../helpers/credential-token-canaries';
import {
  diagnosticSecretCanaries,
  expectDiagnosticCanariesAbsent,
} from '../../helpers/diagnostic-secret-canaries';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

vi.mock('../../../src/services/node-callback-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/node-callback-auth')>()),
  verifyNodeCallbackAuth: vi.fn(async () => undefined),
}));
vi.mock('../../../src/services/diagnostic-incidents', () => ({
  diagnosticIncidentDeploymentId: () => 'test-deployment',
  diagnosticIncidentSignature: async () => 'test-signature',
  ensurePendingIncidents: vi.fn(async () => undefined),
  registerDiagnosticArtifact: vi.fn(),
  uploadDiagnosticArtifact: vi.fn(),
}));

const { nodeDiagnosticIncidentRoutes } = await import(
  '../../../src/routes/node-diagnostic-incidents'
);

const EVERY_CANARY = [...diagnosticSecretCanaries, ...allCredentialTokenCanaries];

function createStores() {
  const primary = new Database(':memory:');
  createSchemaTables(primary, [schema.nodes]);
  primary.prepare(`INSERT INTO nodes (id, status) VALUES ('node-1', 'running')`).run();

  const observability = new Database(':memory:');
  createSchemaTables(observability, [platformErrors]);

  return {
    observability,
    env: {
      DATABASE: createSqliteD1(primary),
      OBSERVABILITY_DATABASE: createSqliteD1(observability),
    } as unknown as Env,
  };
}

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) =>
    err instanceof AppError
      ? c.json(err.toJSON(), err.statusCode)
      : c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500)
  );
  app.route('/api/nodes', nodeDiagnosticIncidentRoutes);
  return app;
}

function reportErrors(env: Env, errors: unknown[]) {
  return createApp().request(
    '/api/nodes/node-1/errors',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer callback-token' },
      body: JSON.stringify({ errors }),
    },
    env
  );
}

describe('POST /api/nodes/:id/errors never persists or logs a credential', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('strips every canary from the stored message, stack and context', async () => {
    const { env, observability } = createStores();
    const consoleLines: string[] = [];
    for (const method of ['error', 'warn', 'log'] as const) {
      vi.spyOn(console, method).mockImplementation((line: unknown) => {
        consoleLines.push(String(line));
      });
    }

    const res = await reportErrors(env, [
      {
        level: 'error',
        source: 'acp-gateway',
        message: `agent crashed during startup: ${EVERY_CANARY.join(' ')}`,
        stack: EVERY_CANARY.map((canary, index) => `  at frame${index} (${canary})`).join('\n'),
      },
      {
        level: 'warn',
        source: 'session-host',
        message: 'agent printed its environment before exiting',
        context: {
          env: { OPENAI_API_KEY: credentialTokenCanaries.openaiProjectKey },
          stderr: `export ANTHROPIC_API_KEY=${credentialTokenCanaries.anthropicApiKey}`,
          lines: [credentialTokenCanaries.openaiLegacyKey, credentialTokenCanaries.samPersonalAccessToken],
        },
      },
    ]);

    expect(res.status).toBe(204);
    const rows = observability
      .prepare('SELECT source, level, message, stack, context, node_id FROM platform_errors ORDER BY level')
      .all() as Array<Record<string, string | null>>;

    // Liveness: both reports were stored with their non-secret text intact.
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.node_id)).toEqual(['node-1', 'node-1']);
    expect(rows[0]?.message).toContain('agent crashed during startup');
    expect(rows[1]?.message).toBe('agent printed its environment before exiting');
    expect(rows[1]?.context).toContain('[REDACTED]');

    expectDiagnosticCanariesAbsent(rows);
    expectCredentialTokensAbsent(rows);
    expect(consoleLines.some((line) => line.includes('vm_agent_error'))).toBe(true);
    expectDiagnosticCanariesAbsent(consoleLines.join('\n'));
    expectCredentialTokensAbsent(consoleLines.join('\n'));
  });
});
