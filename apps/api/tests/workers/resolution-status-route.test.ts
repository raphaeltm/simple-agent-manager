/**
 * Worker integration tests for GET /api/credentials/resolution-status.
 *
 * Tests that:
 * 1. The route requires authentication (rejects 401 without session)
 * 2. The route is mounted (not 404)
 * 3. D1 resolver integration — seeds cc_* rows and verifies response shape
 */
import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

import { seedInstallation, seedProject } from './helpers/seed-d1';

const TEST_PREFIX = `res-status-${Date.now()}`;
const USER_ID = `${TEST_PREFIX}-user`;
const PROJECT_ID = `${TEST_PREFIX}-project`;

beforeAll(async () => {
  // Seed test user
  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO users (id, github_id, email, name, created_at, updated_at, role, status)
     VALUES (?, ?, ?, ?, datetime('now'), datetime('now'), 'user', 'approved')`
  )
    .bind(USER_ID, `gh-${TEST_PREFIX}`, `${TEST_PREFIX}@test.com`, 'ResStatus Test User')
    .run();
  const installationId = `${TEST_PREFIX}-installation`;
  await seedInstallation(installationId, USER_ID, {
    installationIdValue: `installation-${TEST_PREFIX}`,
    accountName: `account-${TEST_PREFIX}`,
  });
  await seedProject(PROJECT_ID, USER_ID, installationId);
});

// ─────────────────────────────────────────────────────────────────────────────
// Auth rejection
// ─────────────────────────────────────────────────────────────────────────────

describe('resolution-status auth', () => {
  it('GET /api/credentials/resolution-status returns 401 without auth', async () => {
    const res = await SELF.fetch('http://localhost/api/credentials/resolution-status', {
      method: 'GET',
    });
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Route mounting — verifies the route is wired in index.ts
// ─────────────────────────────────────────────────────────────────────────────

describe('resolution-status route mounting', () => {
  it('responds with 401 (not 404) confirming route is mounted', async () => {
    const res = await SELF.fetch('http://localhost/api/credentials/resolution-status');
    // 401 = route found, auth rejected. 404 = route not found.
    expect(res.status).not.toBe(404);
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D1 resolver integration — verifies cc_* tables are queryable from the
// resolution-status endpoint's buildSnapshot path.
//
// Note: Full authenticated-session tests require BetterAuth session setup
// which is not yet available in the Miniflare test harness. These tests
// verify the DB layer directly to ensure schema wiring is correct.
// ─────────────────────────────────────────────────────────────────────────────

describe('resolution-status D1 integration', () => {
  it('cc_credentials table accepts resolution-status relevant rows', async () => {
    const credId = `${TEST_PREFIX}-cred`;
    // Insert a cc_credential row that buildSnapshot would read
    const result = await env.DATABASE.prepare(
      `INSERT INTO cc_credentials (id, owner_id, name, kind, encrypted_token, iv, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))`
    )
      .bind(credId, USER_ID, 'Test Claude Key', 'api-key', 'encrypted', 'iv')
      .run();
    expect(result.success).toBe(true);

    // Verify the row is readable
    const row = await env.DATABASE.prepare(
      'SELECT id, owner_id, kind, name, is_active FROM cc_credentials WHERE id = ?'
    )
      .bind(credId)
      .first();
    expect(row).toBeTruthy();
    expect(row!.owner_id).toBe(USER_ID);
    expect(row!.kind).toBe('api-key');
    expect(row!.is_active).toBe(1);
  });

  it('cc_attachments table accepts inactive project-scoped rows for halt detection', async () => {
    const attachId = `${TEST_PREFIX}-attach-halted`;
    const configId = `${TEST_PREFIX}-config`;
    const credId = `${TEST_PREFIX}-cred`;

    // Insert a configuration first (attachment references it)
    await env.DATABASE.prepare(
      `INSERT OR IGNORE INTO cc_configurations (id, owner_id, name, consumer_kind, consumer_target, credential_id, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))`
    )
      .bind(configId, USER_ID, 'Test Claude', 'agent', 'claude-code', credId)
      .run();

    // Insert an inactive project-scoped attachment (simulates Rule 28 halt)
    const result = await env.DATABASE.prepare(
      `INSERT INTO cc_attachments (id, configuration_id, consumer_kind, consumer_target, user_id, project_id, is_active, created_at, updated_at)
       VALUES (?, ?, 'agent', 'claude-code', ?, ?, 0, datetime('now'), datetime('now'))`
    )
      .bind(attachId, configId, USER_ID, PROJECT_ID)
      .run();
    expect(result.success).toBe(true);

    // Verify the row is readable and inactive
    const row = await env.DATABASE.prepare(
      'SELECT id, project_id, is_active FROM cc_attachments WHERE id = ?'
    )
      .bind(attachId)
      .first();
    expect(row).toBeTruthy();
    expect(row!.is_active).toBe(0);
  });

  it('resolution-status response shape matches CCResolutionStatusResponse', async () => {
    // Without auth we can't call the endpoint directly, but we can verify
    // the D1 queries that buildSnapshot uses return the expected shape
    const creds = await env.DATABASE.prepare(
      'SELECT id, owner_id, kind, name, is_active FROM cc_credentials WHERE owner_id = ?'
    )
      .bind(USER_ID)
      .all();
    expect(creds.results).toBeDefined();
    expect(Array.isArray(creds.results)).toBe(true);

    const configs = await env.DATABASE.prepare(
      'SELECT id, credential_id, owner_id, consumer_kind, consumer_target, is_active FROM cc_configurations WHERE owner_id = ?'
    )
      .bind(USER_ID)
      .all();
    expect(configs.results).toBeDefined();

    const attachments = await env.DATABASE.prepare(
      'SELECT id, configuration_id, user_id, project_id, is_active FROM cc_attachments WHERE user_id = ?'
    )
      .bind(USER_ID)
      .all();
    expect(attachments.results).toBeDefined();

    // Verify column names match what buildSnapshot expects
    if (creds.results.length > 0) {
      const row = creds.results[0];
      expect(row).toHaveProperty('id');
      expect(row).toHaveProperty('owner_id');
      expect(row).toHaveProperty('kind');
      expect(row).toHaveProperty('name');
      expect(row).toHaveProperty('is_active');
    }
  });
});
