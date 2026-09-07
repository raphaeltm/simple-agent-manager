import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { updateAIProxyAgentCredentialAttribution } from '../../../src/services/ai-proxy-shared';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

function createEnv() {
  const sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [schema.agentSessions]);
  sqlite.prepare(
    `INSERT INTO agent_sessions (
      id, workspace_id, user_id, agent_type, status,
      agent_credential_source, agent_credential_reference, agent_credential_provider,
      agent_provider_mode, agent_credential_generation, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'session-1',
    'workspace-1',
    'user-1',
    'claude-code',
    'running',
    'project',
    'cc_credentials:initial',
    'anthropic',
    'boot',
    1,
    '2026-09-07T00:00:00.000Z',
    '2026-09-07T00:00:00.000Z'
  );
  return { sqlite, env: { DATABASE: createSqliteD1(sqlite) } as Env };
}

function readCredentialRow(sqlite: Database.Database) {
  return sqlite
    .prepare(
      `SELECT agent_credential_source, agent_credential_reference, agent_credential_provider,
              agent_provider_mode, agent_credential_generation
       FROM agent_sessions WHERE id = ?`
    )
    .get('session-1') as Record<string, unknown>;
}

describe('AI proxy credential attribution generation fence', () => {
  it('prevents an old proxy response from overwriting newer boot credential verification fields', async () => {
    const { sqlite, env } = createEnv();
    const auth = {
      agentSessionId: 'session-1',
      workspaceId: 'workspace-1',
      userId: 'user-1',
      agentType: 'claude-code',
      agentCredentialGeneration: 1,
    };

    await updateAIProxyAgentCredentialAttribution(env, auth, {
      credentialSource: 'project',
      credentialReference: 'cc_credentials:newer-proxy',
      credentialProvider: 'anthropic',
      providerMode: 'proxy-passthrough',
    });
    expect(readCredentialRow(sqlite)).toMatchObject({
      agent_credential_reference: 'cc_credentials:newer-proxy',
      agent_provider_mode: 'proxy-passthrough',
      agent_credential_generation: 2,
    });

    await updateAIProxyAgentCredentialAttribution(env, auth, {
      credentialSource: 'user',
      credentialReference: 'cc_credentials:stale-proxy',
      credentialProvider: 'anthropic',
      providerMode: 'stale-response',
    });
    expect(readCredentialRow(sqlite)).toMatchObject({
      agent_credential_source: 'project',
      agent_credential_reference: 'cc_credentials:newer-proxy',
      agent_provider_mode: 'proxy-passthrough',
      agent_credential_generation: 2,
    });

    await updateAIProxyAgentCredentialAttribution(env, {
      ...auth,
      agentCredentialGeneration: 2,
    }, {
      credentialSource: 'platform',
      credentialReference: 'platform_credentials:current',
      credentialProvider: 'anthropic',
      providerMode: 'sam-proxy',
    });
    expect(readCredentialRow(sqlite)).toMatchObject({
      agent_credential_source: 'platform',
      agent_credential_reference: 'platform_credentials:current',
      agent_provider_mode: 'sam-proxy',
      agent_credential_generation: 3,
    });
  });

  it('does not advance the generation when proxy attribution is unchanged', async () => {
    const { sqlite, env } = createEnv();

    await updateAIProxyAgentCredentialAttribution(env, {
      agentSessionId: 'session-1',
      workspaceId: 'workspace-1',
      userId: 'user-1',
      agentType: 'claude-code',
      agentCredentialGeneration: 1,
    }, {
      credentialSource: 'project',
      credentialReference: 'cc_credentials:initial',
      credentialProvider: 'anthropic',
      providerMode: 'boot',
    });

    expect(readCredentialRow(sqlite)).toMatchObject({
      agent_credential_reference: 'cc_credentials:initial',
      agent_provider_mode: 'boot',
      agent_credential_generation: 1,
    });
  });
});
