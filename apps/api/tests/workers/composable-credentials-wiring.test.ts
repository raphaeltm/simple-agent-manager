/**
 * Integration tests for composable-credentials wiring into live call sites.
 *
 * Tests that:
 * 1. getDecryptedAgentKey resolves via CC path after lazy backfill
 * 2. getDecryptedAgentKey falls back to legacy when CC has no data
 * 3. Lazy backfill populates cc_* tables from legacy credentials
 * 4. CC resolver produces same credential as legacy path (behavioral parity)
 * 5. Rule 28: inactive project-scoped attachment halts resolution
 */
import { env } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { beforeAll, describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema';
import { encrypt } from '../../src/services/encryption';
import { seedInstallation, seedProject, seedUser } from './helpers/seed-d1';

const TEST_PREFIX = `cc-wire-${Date.now()}`;
const USER_A = `${TEST_PREFIX}-user-a`;
const USER_B = `${TEST_PREFIX}-user-b`;
const PROJECT_ID = `${TEST_PREFIX}-proj-1`;
const ENCRYPTION_KEY = 'SK4ihJazAK3GIWUQcM6nZ1odR6KQHrqRAVSp6HdPxrg=';

const AGENT_SECRET = 'sk-test-anthropic-key-12345';

let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  db = drizzle(env.DATABASE, { schema });

  // Seed test users
  for (const userId of [USER_A, USER_B]) {
    await env.DATABASE.prepare(
      `INSERT OR IGNORE INTO users (id, github_id, email, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`
    )
      .bind(userId, `gh-${userId}`, `${userId}@test.com`, `Test User ${userId}`)
      .run();
  }

  // Seed a project for Rule 28 tests
  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO projects (id, user_id, name, normalized_name, created_by, created_at, updated_at)
     VALUES (?, ?, ?, lower(replace(?, ' ', '-')), ?, datetime('now'), datetime('now'))`
  )
    .bind(PROJECT_ID, USER_A, 'Test Project', 'Test Project', USER_A)
    .run();
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper: seed a legacy credential row with real encryption
// ─────────────────────────────────────────────────────────────────────────────

async function seedLegacyCredential(opts: {
  id: string;
  userId: string;
  credentialType: string;
  credentialKind: string;
  agentType: string | null;
  provider: string;
  secret: string;
  projectId?: string | null;
  isActive?: boolean;
}) {
  const { ciphertext, iv } = await encrypt(opts.secret, ENCRYPTION_KEY);
  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO credentials
     (id, user_id, project_id, credential_type, credential_kind, agent_type, provider, encrypted_token, iv, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  )
    .bind(
      opts.id,
      opts.userId,
      opts.projectId ?? null,
      opts.credentialType,
      opts.credentialKind,
      opts.agentType,
      opts.provider,
      ciphertext,
      iv,
      opts.isActive !== false ? 1 : 0
    )
    .run();
}

// ─────────────────────────────────────────────────────────────────────────────
// Test: Lazy backfill from legacy → CC tables
// ─────────────────────────────────────────────────────────────────────────────

describe('lazy backfill wiring', () => {
  const userId = USER_A;
  const credId = `${TEST_PREFIX}-cred-agent-a`;

  beforeAll(async () => {
    // Seed a legacy agent API key for User A
    await seedLegacyCredential({
      id: credId,
      userId,
      credentialType: 'agent-api-key',
      credentialKind: 'api-key',
      agentType: 'claude-code',
      provider: 'anthropic',
      secret: AGENT_SECRET,
    });
  });

  it('user has no cc_* data before backfill', async () => {
    const { results } = await env.DATABASE.prepare(
      `SELECT id FROM cc_credentials WHERE owner_id = ?`
    )
      .bind(userId)
      .all();
    expect(results).toHaveLength(0);
  });

  it('lazyBackfillIfNeeded migrates legacy credentials to cc_* tables', async () => {
    const { lazyBackfillIfNeeded } =
      await import('../../src/services/composable-credentials/lazy-backfill');
    const didBackfill = await lazyBackfillIfNeeded(db, userId);
    expect(didBackfill).toBe(true);

    // Verify cc_credentials was populated
    const { results: creds } = await env.DATABASE.prepare(
      `SELECT id, kind FROM cc_credentials WHERE owner_id = ?`
    )
      .bind(userId)
      .all();
    expect(creds.length).toBeGreaterThan(0);

    // Verify cc_configurations was populated
    const { results: configs } = await env.DATABASE.prepare(
      `SELECT id, consumer_kind, consumer_target FROM cc_configurations WHERE owner_id = ?`
    )
      .bind(userId)
      .all();
    expect(configs.length).toBeGreaterThan(0);

    // Verify cc_attachments was populated
    const { results: atts } = await env.DATABASE.prepare(
      `SELECT id, user_id FROM cc_attachments WHERE user_id = ?`
    )
      .bind(userId)
      .all();
    expect(atts.length).toBeGreaterThan(0);
  });

  it('lazyBackfillIfNeeded returns false on second call (data exists)', async () => {
    const { lazyBackfillIfNeeded } =
      await import('../../src/services/composable-credentials/lazy-backfill');
    const didBackfill = await lazyBackfillIfNeeded(db, userId);
    expect(didBackfill).toBe(false);
  });

  it('reconciles a legacy-only cloud provider row even when cc data already exists', async () => {
    const cloudCredId = `${TEST_PREFIX}-legacy-hetzner-after-cc`;
    const hetznerToken = 'hetzner-token-after-cc-data';
    await seedLegacyCredential({
      id: cloudCredId,
      userId,
      credentialType: 'cloud-provider',
      credentialKind: 'api-key',
      agentType: null,
      provider: 'hetzner',
      secret: hetznerToken,
    });

    const { lazyBackfillIfNeeded } =
      await import('../../src/services/composable-credentials/lazy-backfill');
    const didReconcile = await lazyBackfillIfNeeded(db, userId);
    expect(didReconcile).toBe(true);

    const attachment = await env.DATABASE.prepare(
      `SELECT id, consumer_kind, consumer_target, project_id, is_active
       FROM cc_attachments
       WHERE user_id = ? AND consumer_kind = 'compute' AND consumer_target = 'hetzner'
         AND project_id IS NULL`
    )
      .bind(userId)
      .first();
    expect(attachment).toBeTruthy();
    expect(attachment!.is_active).toBe(1);

    const { resolveForConsumer } =
      await import('../../src/services/composable-credentials/resolve');
    const resolved = await resolveForConsumer(db, userId, ENCRYPTION_KEY, {
      kind: 'compute',
      provider: 'hetzner',
    });

    expect(resolved).not.toBeNull();
    expect(resolved!.source).toBe('user-attachment');
    expect(resolved!.credential?.secret.kind).toBe('cloud-provider');
    if (resolved!.credential?.secret.kind === 'cloud-provider') {
      expect(resolved!.credential.secret.provider).toBe('hetzner');
      expect(resolved!.credential.secret.token).toBe(hetznerToken);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test: CC resolver produces same credential as legacy
// ─────────────────────────────────────────────────────────────────────────────

describe('CC resolver behavioral parity with legacy', () => {
  const userId = USER_A;

  it('resolveForConsumer returns the agent credential after backfill', async () => {
    const { resolveForConsumer } =
      await import('../../src/services/composable-credentials/resolve');
    const consumer = { kind: 'agent' as const, agentType: 'claude-code' };
    const resolved = await resolveForConsumer(db, userId, ENCRYPTION_KEY, consumer);

    expect(resolved).not.toBeNull();
    expect(resolved!.credential).toBeDefined();
    expect(resolved!.credential!.secret.kind).toBe('api-key');
    if (resolved!.credential!.secret.kind === 'api-key') {
      expect(resolved!.credential!.secret.apiKey).toBe(AGENT_SECRET);
    }
    expect(resolved!.source).toBe('user-attachment');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test: getDecryptedAgentKey — full vertical slice
// ─────────────────────────────────────────────────────────────────────────────

describe('getDecryptedAgentKey CC-primary wiring', () => {
  it('resolves via CC for user with backfilled data', async () => {
    // User A already has cc_* data from the lazy backfill test above
    const { getDecryptedAgentKey } = await import('../../src/routes/credentials');
    const result = await getDecryptedAgentKey(db, USER_A, 'claude-code', ENCRYPTION_KEY);

    expect(result).not.toBeNull();
    expect(result!.credential).toBe(AGENT_SECRET);
    expect(result!.credentialKind).toBe('api-key');
    expect(result!.credentialSource).toBe('user');
  });

  it('falls back to legacy for user with no cc_* data', async () => {
    // User B has legacy credentials but no cc_* data yet
    await seedLegacyCredential({
      id: `${TEST_PREFIX}-cred-agent-b`,
      userId: USER_B,
      credentialType: 'agent-api-key',
      credentialKind: 'api-key',
      agentType: 'claude-code',
      provider: 'anthropic',
      secret: 'sk-user-b-key',
    });

    const { getDecryptedAgentKey } = await import('../../src/routes/credentials');
    const result = await getDecryptedAgentKey(db, USER_B, 'claude-code', ENCRYPTION_KEY);

    expect(result).not.toBeNull();
    expect(result!.credential).toBe('sk-user-b-key');
    expect(result!.credentialKind).toBe('api-key');
    // After this call, lazy backfill should have populated cc_* tables
    // (the function calls lazyBackfillIfNeeded internally)
  });

  it('returns null for non-existent agent type', async () => {
    const { getDecryptedAgentKey } = await import('../../src/routes/credentials');
    const result = await getDecryptedAgentKey(db, USER_A, 'nonexistent-agent', ENCRYPTION_KEY);
    expect(result).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test: Rule 28 — inactive project-scoped attachment halts resolution
// ─────────────────────────────────────────────────────────────────────────────

describe('Rule 28: inactive project-scoped attachment halts resolution', () => {
  const userId = USER_A;

  beforeAll(async () => {
    await seedUser(userId);
    await seedInstallation(`${TEST_PREFIX}-install-rule28`, userId);
    await seedProject(PROJECT_ID, userId, `${TEST_PREFIX}-install-rule28`);

    // Seed a project-scoped INACTIVE credential in legacy table
    await seedLegacyCredential({
      id: `${TEST_PREFIX}-cred-proj-inactive`,
      userId,
      credentialType: 'agent-api-key',
      credentialKind: 'api-key',
      agentType: 'claude-code',
      provider: 'anthropic',
      secret: 'sk-project-inactive',
      projectId: PROJECT_ID,
      isActive: false,
    });

    // Run backfill for this user to get cc_* data with the inactive project row
    const { runBackfill } =
      await import('../../src/services/composable-credentials/backfill-service');
    await runBackfill(db, { userId });
  });

  it('legacy path: inactive project cred halts (returns null)', async () => {
    const { getDecryptedAgentKey } = await import('../../src/routes/credentials');
    // When querying with projectId, the inactive project cred should block fallthrough
    const result = await getDecryptedAgentKey(
      db,
      userId,
      'claude-code',
      ENCRYPTION_KEY,
      PROJECT_ID
    );
    // Rule 28: inactive project row blocks fallthrough to user-scoped
    expect(result).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Regression: normal replacement must update the composable credential graph, and
// Codex auth-json rows must resolve to the VM agent's oauth-token/auth-file mode.
// ─────────────────────────────────────────────────────────────────────────────

const USER_CODEX_REPLACE = `${TEST_PREFIX}-user-codex-replace`;
const USER_CODEX_MANUAL = `${TEST_PREFIX}-user-codex-manual`;
const USER_OPENCODE_SYNC = `${TEST_PREFIX}-user-opencode-sync`;

function codexAuthJson(accessToken: string): string {
  return JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      access_token: accessToken,
      refresh_token: `refresh-${accessToken}`,
      account_id: `acct-${accessToken}`,
    },
    last_refresh: '2026-06-15T00:00:00.000Z',
  });
}

describe('Codex composable credential replacement and runtime mapping', () => {
  beforeAll(async () => {
    for (const uid of [USER_CODEX_REPLACE, USER_CODEX_MANUAL, USER_OPENCODE_SYNC]) {
      await env.DATABASE.prepare(
        `INSERT OR IGNORE INTO users (id, github_id, email, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`
      )
        .bind(uid, `gh-${uid}`, `${uid}@test.com`, `Test User ${uid}`)
        .run();
    }
  });

  it('replace creates a fresh auth-json credential and makes it the only active Codex attachment', async () => {
    const { syncAgentCredentialToCC } =
      await import('../../src/services/composable-credentials/agent-sync');
    const oldAuthJson = codexAuthJson('old-access-token');
    const newAuthJson = codexAuthJson('new-access-token');
    const oldEncrypted = await encrypt(oldAuthJson, ENCRYPTION_KEY);
    const newEncrypted = await encrypt(newAuthJson, ENCRYPTION_KEY);

    await syncAgentCredentialToCC(env.DATABASE, {
      userId: USER_CODEX_REPLACE,
      agentType: 'openai-codex',
      credentialKind: 'oauth-token',
      encryptedToken: oldEncrypted.ciphertext,
      iv: oldEncrypted.iv,
      agentName: 'OpenAI Codex',
      isActive: true,
    });
    await syncAgentCredentialToCC(env.DATABASE, {
      userId: USER_CODEX_REPLACE,
      agentType: 'openai-codex',
      credentialKind: 'oauth-token',
      encryptedToken: newEncrypted.ciphertext,
      iv: newEncrypted.iv,
      agentName: 'OpenAI Codex',
      isActive: true,
    });

    const { results: attachments } = await env.DATABASE.prepare(
      `SELECT id, configuration_id, is_active
       FROM cc_attachments
       WHERE user_id = ? AND project_id IS NULL
         AND consumer_kind = 'agent' AND consumer_target = 'openai-codex'`
    )
      .bind(USER_CODEX_REPLACE)
      .all();
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.is_active).toBe(1);

    const { results: activeKinds } = await env.DATABASE.prepare(
      `SELECT cred.kind
       FROM cc_attachments att
       JOIN cc_configurations cfg ON cfg.id = att.configuration_id
       JOIN cc_credentials cred ON cred.id = cfg.credential_id
       WHERE att.user_id = ? AND att.consumer_target = 'openai-codex'`
    )
      .bind(USER_CODEX_REPLACE)
      .all();
    expect(activeKinds[0]?.kind).toBe('auth-json');

    const { getDecryptedAgentKey } = await import('../../src/routes/credentials');
    const result = await getDecryptedAgentKey(
      db,
      USER_CODEX_REPLACE,
      'openai-codex',
      ENCRYPTION_KEY
    );

    expect(result).not.toBeNull();
    expect(result!.credential).toBe(newAuthJson);
    expect(result!.credentialKind).toBe('oauth-token');
    expect(result!.credentialSource).toBe('user');
  });

  it('OpenCode API key sync creates an OpenCode Zen configuration', async () => {
    const { syncAgentCredentialToCC } =
      await import('../../src/services/composable-credentials/agent-sync');
    const encrypted = await encrypt('sk-opencode-zen', ENCRYPTION_KEY);

    await syncAgentCredentialToCC(env.DATABASE, {
      userId: USER_OPENCODE_SYNC,
      agentType: 'opencode',
      credentialKind: 'api-key',
      encryptedToken: encrypted.ciphertext,
      iv: encrypted.iv,
      agentName: 'OpenCode',
      isActive: true,
    });

    const { results } = await env.DATABASE.prepare(
      `SELECT cfg.settings_json
       FROM cc_attachments att
       JOIN cc_configurations cfg ON cfg.id = att.configuration_id
       JOIN cc_credentials cred ON cred.id = cfg.credential_id
       WHERE att.user_id = ?
         AND att.project_id IS NULL
         AND att.consumer_kind = 'agent'
         AND att.consumer_target = 'opencode'
         AND cred.kind = 'api-key'`
    )
      .bind(USER_OPENCODE_SYNC)
      .all<{ settings_json: string | null }>();

    expect(results).toHaveLength(1);
    expect(JSON.parse(results[0]?.settings_json ?? '{}')).toEqual({
      providerId: 'opencode-zen',
      model: 'opencode/claude-sonnet-4-6',
    });
  });

  it('manual auth-json configuration resolves to oauth-token auth-file mode for Codex', async () => {
    const authJson = codexAuthJson('manual-access-token');
    const { ciphertext, iv } = await encrypt(authJson, ENCRYPTION_KEY);
    const credentialId = `${TEST_PREFIX}-manual-codex-cred`;
    const configurationId = `${TEST_PREFIX}-manual-codex-cfg`;
    const attachmentId = `${TEST_PREFIX}-manual-codex-att`;

    await env.DATABASE.prepare(
      `INSERT INTO cc_credentials (id, owner_id, name, kind, encrypted_token, iv, is_active, created_at, updated_at)
       VALUES (?, ?, 'Manual Codex auth.json', 'auth-json', ?, ?, 1, datetime('now'), datetime('now'))`
    )
      .bind(credentialId, USER_CODEX_MANUAL, ciphertext, iv)
      .run();
    await env.DATABASE.prepare(
      `INSERT INTO cc_configurations (id, owner_id, name, consumer_kind, consumer_target, credential_id, settings_json, is_active, created_at, updated_at)
       VALUES (?, ?, 'Codex default', 'agent', 'openai-codex', ?, NULL, 1, datetime('now'), datetime('now'))`
    )
      .bind(configurationId, USER_CODEX_MANUAL, credentialId)
      .run();
    await env.DATABASE.prepare(
      `INSERT INTO cc_attachments (id, configuration_id, consumer_kind, consumer_target, user_id, project_id, is_active, created_at, updated_at)
       VALUES (?, ?, 'agent', 'openai-codex', ?, NULL, 1, datetime('now'), datetime('now'))`
    )
      .bind(attachmentId, configurationId, USER_CODEX_MANUAL)
      .run();

    const { getDecryptedAgentKey } = await import('../../src/routes/credentials');
    const result = await getDecryptedAgentKey(
      db,
      USER_CODEX_MANUAL,
      'openai-codex',
      ENCRYPTION_KEY
    );

    expect(result).toEqual({
      credential: authJson,
      credentialKind: 'oauth-token',
      credentialSource: 'user',
    });
  });

  it('disconnect removes the active Codex attachment from resolution', async () => {
    const { disconnectAgentCredentialFromCC } =
      await import('../../src/services/composable-credentials/agent-sync');

    await disconnectAgentCredentialFromCC(env.DATABASE, {
      userId: USER_CODEX_REPLACE,
      agentType: 'openai-codex',
    });

    const { getDecryptedAgentKey } = await import('../../src/routes/credentials');
    const result = await getDecryptedAgentKey(
      db,
      USER_CODEX_REPLACE,
      'openai-codex',
      ENCRYPTION_KEY
    );
    expect(result).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Regression: enabled platform default must NOT short-circuit lazy backfill of a
// user's own (higher-precedence) legacy credential.
//
// THE BUG (production rollback): an ENABLED platform agent-api-key default resolves
// at Tier 3 on the FIRST resolveForConsumer call (non-null). The original
// `if (!resolved)` guard saw a non-null result and SKIPPED lazy backfill, so the
// user's own credential never migrated into cc_*, the legacy fallback was skipped,
// and getDecryptedAgentKey returned the platform credential (mapped to null for a
// platform proxy, or the wrong credential) → the VM agent 404'd the user's own key
// for non-'sam' provider modes.
//
// This describe block runs LAST so the global enabled platform default it seeds
// cannot contaminate the earlier source:'user' assertions.
// ─────────────────────────────────────────────────────────────────────────────

const USER_C = `${TEST_PREFIX}-user-c`;
const USER_D = `${TEST_PREFIX}-user-d`;
const USER_E = `${TEST_PREFIX}-user-e`;
const USER_F = `${TEST_PREFIX}-user-f`;
const USER_G = `${TEST_PREFIX}-user-g`;
const USER_H = `${TEST_PREFIX}-user-h`;
const USER_I = `${TEST_PREFIX}-user-i`;
const USER_J = `${TEST_PREFIX}-user-j`;
const PROJECT_E = `${TEST_PREFIX}-proj-e`;

async function seedPlatformCredential(opts: {
  id: string;
  createdBy: string;
  credentialType: 'agent-api-key' | 'cloud-provider';
  credentialKind: string;
  agentType: string | null;
  provider: string | null;
  secret: string;
  isEnabled?: boolean;
}) {
  const { ciphertext, iv } = await encrypt(opts.secret, ENCRYPTION_KEY);
  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO platform_credentials
     (id, credential_type, provider, agent_type, credential_kind, label, encrypted_token, iv, is_enabled, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  )
    .bind(
      opts.id,
      opts.credentialType,
      opts.provider,
      opts.agentType,
      opts.credentialKind,
      `platform ${opts.id}`,
      ciphertext,
      iv,
      opts.isEnabled !== false ? 1 : 0,
      opts.createdBy
    )
    .run();
}

describe('enabled platform default does not short-circuit user backfill', () => {
  const PLATFORM_SECRET = 'sk-platform-claude-default';
  const USER_C_OAUTH = 'oauth-user-c-own-token';

  const USER_G_HETZNER = 'user-g-own-hetzner-token';
  const USER_F_HETZNER = 'user-f-own-hetzner-token';

  beforeAll(async () => {
    // Seed fresh users so earlier tests are unaffected
    for (const uid of [USER_C, USER_D, USER_E, USER_F, USER_G, USER_H, USER_I, USER_J]) {
      await env.DATABASE.prepare(
        `INSERT OR IGNORE INTO users (id, github_id, email, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`
      )
        .bind(uid, `gh-${uid}`, `${uid}@test.com`, `Test User ${uid}`)
        .run();
    }

    // Project owned by USER_E for the Rule-28-via-platformOnly halt test
    await seedUser(USER_E);
    await seedInstallation(`${TEST_PREFIX}-install-e`, USER_E, {
      installationIdValue: `inst-${TEST_PREFIX}-e`,
      accountName: `account-${TEST_PREFIX}-e`,
    });
    await seedProject(PROJECT_E, USER_E, `${TEST_PREFIX}-install-e`);

    // User C owns their OWN claude-code oauth-token, in the LEGACY table only (empty cc_*)
    await seedLegacyCredential({
      id: `${TEST_PREFIX}-cred-user-c-oauth`,
      userId: USER_C,
      credentialType: 'agent-api-key',
      credentialKind: 'oauth-token',
      agentType: 'claude-code',
      provider: 'anthropic',
      secret: USER_C_OAUTH,
    });

    // User E owns ONLY an INACTIVE project-scoped claude-code cred (empty cc_* until
    // resolution triggers lazy backfill). With an enabled platform default present,
    // the FIRST resolveForConsumer returns the platform default (platformOnly), the
    // platformOnly path lazy-backfills, then re-resolves WITH projectId — Tier 1 finds
    // the inactive project attachment and Rule 28 halts the chain to null.
    await seedLegacyCredential({
      id: `${TEST_PREFIX}-cred-user-e-proj-inactive`,
      userId: USER_E,
      credentialType: 'agent-api-key',
      credentialKind: 'api-key',
      agentType: 'claude-code',
      provider: 'anthropic',
      secret: 'sk-user-e-project-inactive',
      projectId: PROJECT_E,
      isActive: false,
    });

    // User F has cc_* data for an UNRELATED consumer (a cloud-provider), but NO
    // claude-code agent credential. Backfill is run now so cc_* is non-empty →
    // lazyBackfillIfNeeded returns false at test time → exercises the
    // `platformOnly && !didBackfill` fall-through arm (returns the platform default).
    await seedLegacyCredential({
      id: `${TEST_PREFIX}-cred-user-f-hetzner`,
      userId: USER_F,
      credentialType: 'cloud-provider',
      credentialKind: 'api-key',
      agentType: null,
      provider: 'hetzner',
      secret: USER_F_HETZNER,
    });
    const { runBackfill: runBackfillF } =
      await import('../../src/services/composable-credentials/backfill-service');
    await runBackfillF(db, { userId: USER_F });

    // User G owns their OWN hetzner cloud-provider cred (legacy only, empty cc_*) —
    // used to prove the compute path (createProviderForUser) also lazy-backfills past
    // an enabled platform cloud-provider default rather than short-circuiting to it.
    await seedLegacyCredential({
      id: `${TEST_PREFIX}-cred-user-g-hetzner`,
      userId: USER_G,
      credentialType: 'cloud-provider',
      credentialKind: 'api-key',
      agentType: null,
      provider: 'hetzner',
      secret: USER_G_HETZNER,
    });

    // An ENABLED platform claude-code default exists (the Tier-3 short-circuit trigger)
    await seedPlatformCredential({
      id: `${TEST_PREFIX}-platform-claude`,
      createdBy: USER_C,
      credentialType: 'agent-api-key',
      credentialKind: 'api-key',
      agentType: 'claude-code',
      provider: null,
      secret: PLATFORM_SECRET,
      isEnabled: true,
    });

    // An ENABLED platform hetzner cloud-provider default (compute-path short-circuit trigger)
    await seedPlatformCredential({
      id: `${TEST_PREFIX}-platform-hetzner`,
      createdBy: USER_C,
      credentialType: 'cloud-provider',
      credentialKind: 'api-key',
      agentType: null,
      provider: 'hetzner',
      secret: 'platform-hetzner-token',
      isEnabled: true,
    });

    const { ciphertext: authJsonCiphertext, iv: authJsonIv } = await encrypt(
      '{"tokens":{"access_token":"codex-access-token","refresh_token":"codex-refresh-token"}}',
      ENCRYPTION_KEY
    );
    await env.DATABASE.prepare(
      `INSERT INTO cc_credentials
       (id, owner_id, name, kind, encrypted_token, iv, is_active, created_at, updated_at)
       VALUES (?, ?, ?, 'auth-json', ?, ?, 1, datetime('now'), datetime('now'))`
    )
      .bind(
        `${TEST_PREFIX}-cc-codex-auth-json`,
        USER_I,
        'Codex auth.json',
        authJsonCiphertext,
        authJsonIv
      )
      .run();
    await env.DATABASE.prepare(
      `INSERT INTO cc_configurations
       (id, owner_id, name, consumer_kind, consumer_target, credential_id, settings_json, is_active, created_at, updated_at)
       VALUES (?, ?, ?, 'agent', 'openai-codex', ?, '{}', 1, datetime('now'), datetime('now'))`
    )
      .bind(
        `${TEST_PREFIX}-cc-codex-auth-json-cfg`,
        USER_I,
        'Codex auth.json config',
        `${TEST_PREFIX}-cc-codex-auth-json`
      )
      .run();
    await env.DATABASE.prepare(
      `INSERT INTO cc_attachments
       (id, configuration_id, consumer_kind, consumer_target, user_id, project_id, is_active, created_at, updated_at)
       VALUES (?, ?, 'agent', 'openai-codex', ?, NULL, 1, datetime('now'), datetime('now'))`
    )
      .bind(
        `${TEST_PREFIX}-cc-codex-auth-json-att`,
        `${TEST_PREFIX}-cc-codex-auth-json-cfg`,
        USER_I
      )
      .run();

    const { ciphertext: mismatchedCloudCiphertext, iv: mismatchedCloudIv } = await encrypt(
      JSON.stringify({ provider: 'scaleway', token: 'scaleway-secret-for-hetzner-consumer' }),
      ENCRYPTION_KEY
    );
    await env.DATABASE.prepare(
      `INSERT INTO cc_credentials
       (id, owner_id, name, kind, encrypted_token, iv, is_active, created_at, updated_at)
       VALUES (?, ?, ?, 'cloud-provider', ?, ?, 1, datetime('now'), datetime('now'))`
    )
      .bind(
        `${TEST_PREFIX}-cc-mismatch-cloud`,
        USER_J,
        'Scaleway secret attached to Hetzner',
        mismatchedCloudCiphertext,
        mismatchedCloudIv
      )
      .run();
    await env.DATABASE.prepare(
      `INSERT INTO cc_configurations
       (id, owner_id, name, consumer_kind, consumer_target, credential_id, settings_json, is_active, created_at, updated_at)
       VALUES (?, ?, ?, 'compute', 'hetzner', ?, '{}', 1, datetime('now'), datetime('now'))`
    )
      .bind(
        `${TEST_PREFIX}-cc-mismatch-cfg`,
        USER_J,
        'Hetzner compute with mismatched secret',
        `${TEST_PREFIX}-cc-mismatch-cloud`
      )
      .run();
    await env.DATABASE.prepare(
      `INSERT INTO cc_attachments
       (id, configuration_id, consumer_kind, consumer_target, user_id, project_id, is_active, created_at, updated_at)
       VALUES (?, ?, 'compute', 'hetzner', ?, NULL, 1, datetime('now'), datetime('now'))`
    )
      .bind(`${TEST_PREFIX}-cc-mismatch-att`, `${TEST_PREFIX}-cc-mismatch-cfg`, USER_J)
      .run();
  });

  it('user has no cc_* data before resolution (legacy-only)', async () => {
    const { results } = await env.DATABASE.prepare(
      `SELECT id FROM cc_credentials WHERE owner_id = ?`
    )
      .bind(USER_C)
      .all();
    expect(results).toHaveLength(0);
  });

  it("resolves to the USER's own oauth-token, NOT the enabled platform default", async () => {
    const { getDecryptedAgentKey } = await import('../../src/routes/credentials');
    const result = await getDecryptedAgentKey(db, USER_C, 'claude-code', ENCRYPTION_KEY);

    expect(result).not.toBeNull();
    // The user's own credential wins — not the platform default
    expect(result!.credential).toBe(USER_C_OAUTH);
    expect(result!.credentialKind).toBe('oauth-token');
    expect(result!.credentialSource).toBe('user');
    // Must NOT be the platform credential
    expect(result!.credential).not.toBe(PLATFORM_SECRET);
  });

  it('lazy backfill populated cc_* from the legacy credential (oauth-token preserved)', async () => {
    const { results } = await env.DATABASE.prepare(
      `SELECT id, kind FROM cc_credentials WHERE owner_id = ?`
    )
      .bind(USER_C)
      .all();
    expect(results.length).toBeGreaterThan(0);
    // The migrated credential must retain its oauth-token kind, not be coerced to api-key.
    expect((results as Array<{ kind: string }>).some((r) => r.kind === 'oauth-token')).toBe(true);
  });

  it('user with NO own credential still falls through to the platform default', async () => {
    const { getDecryptedAgentKey } = await import('../../src/routes/credentials');
    const result = await getDecryptedAgentKey(db, USER_D, 'claude-code', ENCRYPTION_KEY);

    expect(result).not.toBeNull();
    expect(result!.credential).toBe(PLATFORM_SECRET);
    expect(result!.credentialKind).toBe('api-key');
    expect(result!.credentialSource).toBe('platform');
  });

  // Rule 28 halt THROUGH the new platformOnly + lazy-backfill + re-resolve path.
  // The first resolution returns the enabled platform default (platformOnly), the
  // platformOnly arm runs lazy backfill (migrating the inactive project cred), then
  // re-resolves WITH projectId — Tier 1 finds the inactive project attachment and
  // Rule 28 halts to null. This null arm has dedicated code but was previously untested.
  it('Rule 28: inactive project attachment halts even through platformOnly backfill', async () => {
    // Sanity: USER_E starts with empty cc_* (lazy backfill is triggered by resolution)
    const { results: before } = await env.DATABASE.prepare(
      `SELECT id FROM cc_credentials WHERE owner_id = ?`
    )
      .bind(USER_E)
      .all();
    expect(before).toHaveLength(0);

    const { getDecryptedAgentKey } = await import('../../src/routes/credentials');
    const result = await getDecryptedAgentKey(db, USER_E, 'claude-code', ENCRYPTION_KEY, PROJECT_E);

    // Must NOT fall through to the platform default — the inactive project row halts.
    expect(result).toBeNull();
  });

  // platformOnly && !didBackfill fall-through: the user already has cc_* data (for an
  // unrelated consumer), so lazy backfill is skipped (returns false). The first
  // resolution is the platform default (platformOnly), but with no backfill the code
  // must fall through and return that platform default rather than undefined/null.
  it('platformOnly with existing cc_* data (no backfill) returns the platform default', async () => {
    // Sanity: USER_F has cc_* data but no claude-code agent credential
    const { results: ccRows } = await env.DATABASE.prepare(
      `SELECT id FROM cc_credentials WHERE owner_id = ?`
    )
      .bind(USER_F)
      .all();
    expect(ccRows.length).toBeGreaterThan(0);

    const { getDecryptedAgentKey } = await import('../../src/routes/credentials');
    const result = await getDecryptedAgentKey(db, USER_F, 'claude-code', ENCRYPTION_KEY);

    expect(result).not.toBeNull();
    expect(result!.credential).toBe(PLATFORM_SECRET);
    expect(result!.credentialSource).toBe('platform');
  });

  // Compute path (createProviderForUser → resolveProviderViaCC) must NOT short-circuit
  // to an enabled platform cloud-provider default: it lazy-backfills the user's own
  // legacy cred and re-resolves so the user's own credential wins (source 'user').
  it('compute path: user own cloud-provider wins over enabled platform default', async () => {
    const { createProviderForUser } = await import('../../src/services/provider-credentials');
    const result = await createProviderForUser(db, USER_G, ENCRYPTION_KEY, env as never, 'hetzner');

    expect(result).not.toBeNull();
    expect(result!.providerName).toBe('hetzner');
    // The user's own credential is used, NOT the platform default
    expect(result!.credentialSource).toBe('user');
  });

  it('Codex auth-json CC credential resolves as oauth-token for auth-file injection', async () => {
    const { getDecryptedAgentKey } = await import('../../src/routes/credentials');
    const result = await getDecryptedAgentKey(db, USER_I, 'openai-codex', ENCRYPTION_KEY);

    expect(result).not.toBeNull();
    expect(result!.credential).toContain('codex-access-token');
    expect(result!.credentialKind).toBe('oauth-token');
    expect(result!.credentialSource).toBe('user');
    expect(result!.baseUrl).toBeUndefined();
    expect(result!.providerDialect).toBeUndefined();
  });

  it('compute path: user with NO cloud-provider cred falls through to platform default', async () => {
    const { createProviderForUser } = await import('../../src/services/provider-credentials');
    const result = await createProviderForUser(db, USER_H, ENCRYPTION_KEY, env as never, 'hetzner');

    expect(result).not.toBeNull();
    expect(result!.providerName).toBe('hetzner');
    expect(result!.credentialSource).toBe('platform');
  });

  it('compute path: mismatched CC cloud-provider secret is rejected before provider creation', async () => {
    const { createProviderForUser } = await import('../../src/services/provider-credentials');

    await expect(
      createProviderForUser(db, USER_J, ENCRYPTION_KEY, env as never, 'hetzner')
    ).rejects.toThrow('compute provider mismatch: requested hetzner, credential is scaleway');
  });
});
