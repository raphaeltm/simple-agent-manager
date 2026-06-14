/**
 * Regression tests for snapshot resilience.
 *
 * Root cause of the CC-merge production outage (PR #1315): an enabled
 * `platform_credentials` cloud-provider row stores a RAW token (hetzner), not
 * JSON. `parseSecret('cloud-provider')` called `JSON.parse` on it and threw a
 * SyntaxError. `buildPlatformDefaults` runs on EVERY snapshot build, so the
 * throw rejected the whole snapshot — which has no try/catch upstream in
 * getDecryptedAgentKey — and the agent-key endpoint returned 500. The VM agent
 * saw "control plane returned status 500", SelectAgent failed, and every agent
 * for every user reported "agent status is error".
 *
 * These tests assert:
 * 1. A raw (non-JSON) cloud-provider platform default does NOT crash the
 *    snapshot, and agent resolution for an unrelated agent still succeeds.
 * 2. A JSON cloud-provider platform default ({provider, token}) still parses.
 * 3. A single undecryptable user credential is skipped, not fatal.
 */
import { env } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { beforeAll, describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema';
import { encrypt } from '../../src/services/encryption';

const TEST_PREFIX = `cc-snap-${Date.now()}`;
const USER = `${TEST_PREFIX}-user`;
const ADMIN = `${TEST_PREFIX}-admin`;
const ENCRYPTION_KEY = 'SK4ihJazAK3GIWUQcM6nZ1odR6KQHrqRAVSp6HdPxrg=';
const AGENT_SECRET = 'sk-test-anthropic-key-resilience';

let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  db = drizzle(env.DATABASE, { schema });

  for (const userId of [USER, ADMIN]) {
    await env.DATABASE.prepare(
      `INSERT OR IGNORE INTO users (id, github_id, email, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`,
    )
      .bind(userId, `gh-${userId}`, `${userId}@test.com`, `Test ${userId}`)
      .run();
  }

  // Seed a legacy agent API key and backfill so the user has cc_* data.
  const { ciphertext, iv } = await encrypt(AGENT_SECRET, ENCRYPTION_KEY);
  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO credentials
     (id, user_id, project_id, credential_type, credential_kind, agent_type, provider, encrypted_token, iv, is_active, created_at, updated_at)
     VALUES (?, ?, NULL, 'agent-api-key', 'api-key', 'claude-code', 'anthropic', ?, ?, 1, datetime('now'), datetime('now'))`,
  )
    .bind(`${TEST_PREFIX}-cred-agent`, USER, ciphertext, iv)
    .run();

  const { runBackfill } = await import(
    '../../src/services/composable-credentials/backfill-service'
  );
  await runBackfill(db, { userId: USER });
});

async function seedPlatformCloudProvider(opts: {
  id: string;
  provider: string;
  secret: string;
}) {
  const { ciphertext, iv } = await encrypt(opts.secret, ENCRYPTION_KEY);
  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO platform_credentials
     (id, credential_type, provider, agent_type, credential_kind, label, encrypted_token, iv, is_enabled, created_by, created_at, updated_at)
     VALUES (?, 'cloud-provider', ?, NULL, 'api-key', ?, ?, ?, 1, ?, datetime('now'), datetime('now'))`,
  )
    .bind(opts.id, opts.provider, `platform ${opts.provider}`, ciphertext, iv, ADMIN)
    .run();
}

describe('snapshot resilience to raw cloud-provider platform defaults', () => {
  it('raw (non-JSON) hetzner platform token does not crash the snapshot', async () => {
    // Hetzner tokens are stored raw — not JSON. This is the exact row that
    // crashed production.
    await seedPlatformCloudProvider({
      id: `${TEST_PREFIX}-plat-hetzner`,
      provider: 'hetzner',
      secret: 'raw-hetzner-token-not-json-1234567890abcdef',
    });

    const { buildSnapshot } = await import(
      '../../src/services/composable-credentials/snapshot'
    );
    // Must not throw.
    const snapshot = await buildSnapshot(db, USER, ENCRYPTION_KEY);

    const hetznerDefault = snapshot.platform['compute:hetzner'];
    expect(hetznerDefault).toBeDefined();
    expect(hetznerDefault.mode).toBe('credential');
    expect(hetznerDefault.credential?.secret.kind).toBe('cloud-provider');
    if (hetznerDefault.credential?.secret.kind === 'cloud-provider') {
      expect(hetznerDefault.credential.secret.token).toBe(
        'raw-hetzner-token-not-json-1234567890abcdef',
      );
    }
  });

  it('agent resolution still succeeds despite the raw cloud-provider default', async () => {
    const { resolveForConsumer } = await import(
      '../../src/services/composable-credentials/resolve'
    );
    const resolved = await resolveForConsumer(db, USER, ENCRYPTION_KEY, {
      kind: 'agent',
      agentType: 'claude-code',
    });

    expect(resolved).not.toBeNull();
    expect(resolved!.credential?.secret.kind).toBe('api-key');
    if (resolved!.credential?.secret.kind === 'api-key') {
      expect(resolved!.credential.secret.apiKey).toBe(AGENT_SECRET);
    }
  });

  it('getDecryptedAgentKey returns the agent key (no 500) with the raw default present', async () => {
    const { getDecryptedAgentKey } = await import('../../src/routes/credentials');
    const result = await getDecryptedAgentKey(db, USER, 'claude-code', ENCRYPTION_KEY);

    expect(result).not.toBeNull();
    expect(result!.credential).toBe(AGENT_SECRET);
    expect(result!.credentialKind).toBe('api-key');
  });

  it('JSON cloud-provider platform token ({provider, token}) still parses', async () => {
    await seedPlatformCloudProvider({
      id: `${TEST_PREFIX}-plat-scaleway`,
      provider: 'scaleway',
      secret: JSON.stringify({ provider: 'scaleway', token: 'scw-secret-token' }),
    });

    const { buildSnapshot } = await import(
      '../../src/services/composable-credentials/snapshot'
    );
    const snapshot = await buildSnapshot(db, USER, ENCRYPTION_KEY);

    const scwDefault = snapshot.platform['compute:scaleway'];
    expect(scwDefault?.credential?.secret.kind).toBe('cloud-provider');
    if (scwDefault?.credential?.secret.kind === 'cloud-provider') {
      expect(scwDefault.credential.secret.provider).toBe('scaleway');
      expect(scwDefault.credential.secret.token).toBe('scw-secret-token');
    }
  });

  it('an undecryptable user credential is skipped, not fatal', async () => {
    // Insert a cc_credentials row with a bogus iv so decrypt throws.
    await env.DATABASE.prepare(
      `INSERT OR IGNORE INTO cc_credentials
       (id, owner_id, name, kind, encrypted_token, iv, is_active, created_at, updated_at)
       VALUES (?, ?, 'broken', 'api-key', 'not-real-ciphertext', 'bad-iv', 1, datetime('now'), datetime('now'))`,
    )
      .bind(`${TEST_PREFIX}-cred-broken`, USER)
      .run();

    const { buildSnapshot } = await import(
      '../../src/services/composable-credentials/snapshot'
    );
    // Must not throw — the broken row is skipped.
    const snapshot = await buildSnapshot(db, USER, ENCRYPTION_KEY);

    // The broken credential is absent, but the good agent credential remains.
    const ids = snapshot.credentials.map((c) => c.id);
    expect(ids).not.toContain(`${TEST_PREFIX}-cred-broken`);
    expect(snapshot.credentials.length).toBeGreaterThan(0);
  });
});
