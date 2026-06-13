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
       VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`,
    )
      .bind(userId, `gh-${userId}`, `${userId}@test.com`, `Test User ${userId}`)
      .run();
  }

  // Seed a project for Rule 28 tests
  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO projects (id, user_id, name, created_at, updated_at)
     VALUES (?, ?, ?, datetime('now'), datetime('now'))`,
  )
    .bind(PROJECT_ID, USER_A, 'Test Project')
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
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
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
      opts.isActive !== false ? 1 : 0,
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
      `SELECT id FROM cc_credentials WHERE owner_id = ?`,
    )
      .bind(userId)
      .all();
    expect(results).toHaveLength(0);
  });

  it('lazyBackfillIfNeeded migrates legacy credentials to cc_* tables', async () => {
    const { lazyBackfillIfNeeded } = await import(
      '../../src/services/composable-credentials/lazy-backfill'
    );
    const didBackfill = await lazyBackfillIfNeeded(db, userId);
    expect(didBackfill).toBe(true);

    // Verify cc_credentials was populated
    const { results: creds } = await env.DATABASE.prepare(
      `SELECT id, kind FROM cc_credentials WHERE owner_id = ?`,
    )
      .bind(userId)
      .all();
    expect(creds.length).toBeGreaterThan(0);

    // Verify cc_configurations was populated
    const { results: configs } = await env.DATABASE.prepare(
      `SELECT id, consumer_kind, consumer_target FROM cc_configurations WHERE owner_id = ?`,
    )
      .bind(userId)
      .all();
    expect(configs.length).toBeGreaterThan(0);

    // Verify cc_attachments was populated
    const { results: atts } = await env.DATABASE.prepare(
      `SELECT id, user_id FROM cc_attachments WHERE user_id = ?`,
    )
      .bind(userId)
      .all();
    expect(atts.length).toBeGreaterThan(0);
  });

  it('lazyBackfillIfNeeded returns false on second call (data exists)', async () => {
    const { lazyBackfillIfNeeded } = await import(
      '../../src/services/composable-credentials/lazy-backfill'
    );
    const didBackfill = await lazyBackfillIfNeeded(db, userId);
    expect(didBackfill).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test: CC resolver produces same credential as legacy
// ─────────────────────────────────────────────────────────────────────────────

describe('CC resolver behavioral parity with legacy', () => {
  const userId = USER_A;

  it('resolveForConsumer returns the agent credential after backfill', async () => {
    const { resolveForConsumer } = await import(
      '../../src/services/composable-credentials/resolve'
    );
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
    const result = await getDecryptedAgentKey(
      db,
      USER_A,
      'nonexistent-agent',
      ENCRYPTION_KEY,
    );
    expect(result).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test: Rule 28 — inactive project-scoped attachment halts resolution
// ─────────────────────────────────────────────────────────────────────────────

describe('Rule 28: inactive project-scoped attachment halts resolution', () => {
  const userId = USER_A;

  beforeAll(async () => {
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
    const { runBackfill } = await import(
      '../../src/services/composable-credentials/backfill-service'
    );
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
      PROJECT_ID,
    );
    // Rule 28: inactive project row blocks fallthrough to user-scoped
    expect(result).toBeNull();
  });
});
