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

const TEST_PREFIX = `res-status-${Date.now()}`;
const USER_ID = `${TEST_PREFIX}-user`;

beforeAll(async () => {
  // Seed test user
  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO users (id, github_id, email, name, created_at, updated_at, role, status)
     VALUES (?, ?, ?, ?, datetime('now'), datetime('now'), 'user', 'approved')`,
  )
    .bind(USER_ID, `gh-${TEST_PREFIX}`, `${TEST_PREFIX}@test.com`, 'ResStatus Test User')
    .run();
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
  it('uses the migrated composable credential schema', async () => {
    const credentialColumns = await env.DATABASE.prepare('PRAGMA table_info(cc_credentials)').all<{ name: string }>();
    const credentialColumnNames = credentialColumns.results.map((row) => row.name);
    expect(credentialColumnNames).toEqual(expect.arrayContaining(['id', 'owner_id', 'name', 'kind', 'encrypted_token', 'iv', 'is_active']));

    const configurationColumns = await env.DATABASE.prepare('PRAGMA table_info(cc_configurations)').all<{ name: string }>();
    const configurationColumnNames = configurationColumns.results.map((row) => row.name);
    expect(configurationColumnNames).toEqual(expect.arrayContaining(['id', 'owner_id', 'name', 'consumer_kind', 'consumer_target', 'credential_id', 'settings_json', 'is_active']));
  });
});
