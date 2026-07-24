/**
 * Vertical-slice tests for `saveAgentCredentialForUser`
 * (apps/api/src/services/agent-credential-save.ts) — the single writer shared
 * by the manual Connections routes AND the guided Codex setup-terminal DO
 * capture path (see credential-setup-session/index.ts:attemptCapture).
 *
 * Exercises the full write sequence against real D1 (Miniflare): encrypt ->
 * upsert legacy `credentials` row -> dual-write `cc_*` tables via
 * syncAgentCredentialToCC (rule 44). Mirrors the seeding/assertion style of
 * composable-credentials-wiring.test.ts.
 */
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

import { decrypt } from '../../src/services/encryption';
import { seedUser } from './helpers/seed-d1';

const TEST_PREFIX = `agent-cred-save-${Date.now()}`;
const ENCRYPTION_KEY = 'SK4ihJazAK3GIWUQcM6nZ1odR6KQHrqRAVSp6HdPxrg=';

function codexAuthJson(accessToken: string): string {
  return JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      access_token: accessToken,
      refresh_token: `refresh-${accessToken}`,
      account_id: `acct-${accessToken}`,
    },
    last_refresh: '2026-07-01T00:00:00.000Z',
  });
}

interface LegacyCredentialRow {
  id: string;
  is_active: number;
  encrypted_token: string;
  iv: string;
  project_id: string | null;
  credential_kind: string;
  agent_type: string;
}

async function getLegacyCredentials(userId: string, agentType: string): Promise<LegacyCredentialRow[]> {
  const { results } = await env.DATABASE.prepare(
    `SELECT id, is_active, encrypted_token, iv, project_id, credential_kind, agent_type
     FROM credentials WHERE user_id = ? AND agent_type = ? AND credential_type = 'agent-api-key'`
  )
    .bind(userId, agentType)
    .all<LegacyCredentialRow>();
  return results;
}

interface CcAttachmentJoinRow {
  attachment_id: string;
  attachment_is_active: number;
  attachment_project_id: string | null;
  credential_id: string;
  credential_kind: string;
  encrypted_token: string;
  iv: string;
}

async function getCcAttachments(userId: string, agentType: string): Promise<CcAttachmentJoinRow[]> {
  const { results } = await env.DATABASE.prepare(
    `SELECT
       att.id AS attachment_id,
       att.is_active AS attachment_is_active,
       att.project_id AS attachment_project_id,
       cred.id AS credential_id,
       cred.kind AS credential_kind,
       cred.encrypted_token AS encrypted_token,
       cred.iv AS iv
     FROM cc_attachments att
     JOIN cc_configurations cfg ON cfg.id = att.configuration_id
     JOIN cc_credentials cred ON cred.id = cfg.credential_id
     WHERE att.user_id = ? AND att.consumer_kind = 'agent' AND att.consumer_target = ?`
  )
    .bind(userId, agentType)
    .all<CcAttachmentJoinRow>();
  return results;
}

describe('saveAgentCredentialForUser — autoActivate:true dual-write', () => {
  const userId = `${TEST_PREFIX}-user-active`;

  beforeAll(async () => {
    await seedUser(userId);
  });

  it('creates an active legacy credential AND a matching cc_* attachment', async () => {
    const { saveAgentCredentialForUser } = await import('../../src/services/agent-credential-save');
    const authJson = codexAuthJson('first-access-token');

    const result = await saveAgentCredentialForUser({
      env: env as never,
      userId,
      projectId: null,
      agentType: 'openai-codex',
      credentialKind: 'oauth-token',
      credential: authJson,
      provider: 'openai',
      agentName: 'OpenAI Codex',
      autoActivate: true,
    });

    expect(result.created).toBe(true);

    const legacyRows = await getLegacyCredentials(userId, 'openai-codex');
    expect(legacyRows).toHaveLength(1);
    expect(legacyRows[0]!.is_active).toBe(1);
    expect(legacyRows[0]!.project_id).toBeNull();
    expect(legacyRows[0]!.credential_kind).toBe('oauth-token');

    const decryptedLegacy = await decrypt(legacyRows[0]!.encrypted_token, legacyRows[0]!.iv, ENCRYPTION_KEY);
    expect(decryptedLegacy).toBe(authJson);

    const ccAttachments = await getCcAttachments(userId, 'openai-codex');
    expect(ccAttachments).toHaveLength(1);
    expect(ccAttachments[0]!.attachment_is_active).toBe(1);
    expect(ccAttachments[0]!.attachment_project_id).toBeNull();
    // openai-codex + oauth-token maps to the 'auth-json' cc credential kind
    // (see ccKindForAgentCredential in composable-credentials/agent-sync.ts).
    expect(ccAttachments[0]!.credential_kind).toBe('auth-json');

    const decryptedCc = await decrypt(ccAttachments[0]!.encrypted_token, ccAttachments[0]!.iv, ENCRYPTION_KEY);
    expect(decryptedCc).toBe(authJson);
  });

  it('replacing the credential deactivates the old legacy row and leaves exactly one active cc attachment', async () => {
    const { saveAgentCredentialForUser } = await import('../../src/services/agent-credential-save');
    const newAuthJson = codexAuthJson('second-access-token');

    const result = await saveAgentCredentialForUser({
      env: env as never,
      userId,
      projectId: null,
      agentType: 'openai-codex',
      credentialKind: 'oauth-token',
      credential: newAuthJson,
      provider: 'openai',
      agentName: 'OpenAI Codex',
      autoActivate: true,
    });

    // The legacy upsert path UPDATEs the existing row in place (same scope,
    // same agentType/credentialKind), so `created` is false on replacement.
    expect(result.created).toBe(false);

    const legacyRows = await getLegacyCredentials(userId, 'openai-codex');
    expect(legacyRows).toHaveLength(1);
    expect(legacyRows[0]!.is_active).toBe(1);
    const decryptedLegacy = await decrypt(legacyRows[0]!.encrypted_token, legacyRows[0]!.iv, ENCRYPTION_KEY);
    expect(decryptedLegacy).toBe(newAuthJson);

    // syncAgentCredentialToCC deletes-then-recreates attachments for this
    // user/agentType/scope, so exactly one (the new) attachment must remain.
    const ccAttachments = await getCcAttachments(userId, 'openai-codex');
    expect(ccAttachments).toHaveLength(1);
    expect(ccAttachments[0]!.attachment_is_active).toBe(1);
    const decryptedCc = await decrypt(ccAttachments[0]!.encrypted_token, ccAttachments[0]!.iv, ENCRYPTION_KEY);
    expect(decryptedCc).toBe(newAuthJson);
  });
});

describe('saveAgentCredentialForUser — autoActivate:false skips the cc dual-write', () => {
  const userId = `${TEST_PREFIX}-user-inactive`;

  beforeAll(async () => {
    await seedUser(userId);
  });

  it('writes an inactive legacy row and creates NO cc_* rows (the isActive gotcha)', async () => {
    const { saveAgentCredentialForUser } = await import('../../src/services/agent-credential-save');
    const authJson = codexAuthJson('inactive-access-token');

    await saveAgentCredentialForUser({
      env: env as never,
      userId,
      projectId: null,
      agentType: 'openai-codex',
      credentialKind: 'oauth-token',
      credential: authJson,
      provider: 'openai',
      agentName: 'OpenAI Codex',
      autoActivate: false,
    });

    const legacyRows = await getLegacyCredentials(userId, 'openai-codex');
    expect(legacyRows).toHaveLength(1);
    expect(legacyRows[0]!.is_active).toBe(0);

    // syncAgentCredentialToCC returns null (no-op) when isActive === false —
    // no cc_credentials/cc_configurations/cc_attachments rows are written.
    const ccAttachments = await getCcAttachments(userId, 'openai-codex');
    expect(ccAttachments).toHaveLength(0);
  });
});

describe('saveAgentCredentialForUser — project-scoped override is isolated from the user-scoped default', () => {
  const userId = `${TEST_PREFIX}-user-scoped`;
  const projectId = `${TEST_PREFIX}-project-1`;

  beforeAll(async () => {
    await seedUser(userId);
    await env.DATABASE.prepare(
      `INSERT OR IGNORE INTO projects (id, user_id, name, created_at, updated_at)
       VALUES (?, ?, ?, datetime('now'), datetime('now'))`
    )
      .bind(projectId, userId, 'Dual Write Test Project')
      .run();
  });

  it('creates independent active rows for the user scope and the project scope', async () => {
    const { saveAgentCredentialForUser } = await import('../../src/services/agent-credential-save');
    const userScopedAuthJson = codexAuthJson('user-scope-token');
    const projectScopedAuthJson = codexAuthJson('project-scope-token');

    await saveAgentCredentialForUser({
      env: env as never,
      userId,
      projectId: null,
      agentType: 'openai-codex',
      credentialKind: 'oauth-token',
      credential: userScopedAuthJson,
      provider: 'openai',
      agentName: 'OpenAI Codex',
      autoActivate: true,
    });
    await saveAgentCredentialForUser({
      env: env as never,
      userId,
      projectId,
      agentType: 'openai-codex',
      credentialKind: 'oauth-token',
      credential: projectScopedAuthJson,
      provider: 'openai',
      agentName: 'OpenAI Codex',
      autoActivate: true,
    });

    const legacyRows = await getLegacyCredentials(userId, 'openai-codex');
    // One user-scoped (project_id IS NULL) + one project-scoped row — the
    // project-scoped deactivate-siblings query only touches its own project,
    // so the user-scoped row must remain active.
    expect(legacyRows).toHaveLength(2);
    const userScopedRow = legacyRows.find((r) => r.project_id === null);
    const projectScopedRow = legacyRows.find((r) => r.project_id === projectId);
    expect(userScopedRow?.is_active).toBe(1);
    expect(projectScopedRow?.is_active).toBe(1);

    const ccAttachments = await getCcAttachments(userId, 'openai-codex');
    expect(ccAttachments).toHaveLength(2);
    const activeProjectIds = ccAttachments.map((a) => a.attachment_project_id).sort();
    expect(activeProjectIds).toEqual([null, projectId].sort());
  });
});

describe('saveAgentCredentialForUser — defensive format validation', () => {
  const userId = `${TEST_PREFIX}-user-invalid`;

  beforeAll(async () => {
    await seedUser(userId);
  });

  it('rejects a malformed openai-codex credential and writes nothing', async () => {
    const { saveAgentCredentialForUser } = await import('../../src/services/agent-credential-save');

    await expect(
      saveAgentCredentialForUser({
        env: env as never,
        userId,
        projectId: null,
        agentType: 'openai-codex',
        credentialKind: 'oauth-token',
        credential: 'not valid json at all',
        provider: 'openai',
        agentName: 'OpenAI Codex',
        autoActivate: true,
      })
    ).rejects.toThrow();

    const legacyRows = await getLegacyCredentials(userId, 'openai-codex');
    expect(legacyRows).toHaveLength(0);
    const ccAttachments = await getCcAttachments(userId, 'openai-codex');
    expect(ccAttachments).toHaveLength(0);
  });
});
