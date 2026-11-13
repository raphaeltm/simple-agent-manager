/**
 * Node teardown after the placement credential rotates, driven through the real cleanup cron.
 *
 * Real: SQLite schema and credential tables, credential encryption and resolution, the Hetzner
 * provider adapter, strict teardown, cleanup refusal recording and the operator alert. Faked:
 * only Hetzner's HTTP API, as accounts keyed by API token (`fetch` is the network boundary), on
 * top of the shared cleanup handoff fixture.
 */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as observabilitySchema from '../../../src/db/observability-schema';
import { resolveCleanupConfig, runNodeCleanupSweep } from '../../../src/scheduled/node-cleanup';
import { emptyResult } from '../../../src/scheduled/node-cleanup/shared';
import { sweepStrandedNodes } from '../../../src/scheduled/node-cleanup/stranded-node-retirement';
import { encrypt } from '../../../src/services/encryption';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';
import { handoffFixture } from './node-cleanup-handoff-fixture';

vi.mock('../../../src/services/jwt', () => ({ signNodeCallbackToken: async () => 'test-token' }));

const NOW = new Date('2026-09-08T12:00:00.000Z');
const ORIGINAL_TOKEN = 'test-provider-token';
const INSTANCE = '777';
const INCARNATION = 'inc-host';
const INSTALLATION = '0123456789abcdef0123456789abcdef';
const databases: Database.Database[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  databases.splice(0).forEach((db) => db.close());
});

function samLabels(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    managed: 'simple-agent-manager',
    node: 'host',
    role: 'workspace',
    env: 'staging',
    installation: INSTALLATION,
    incarnation: INCARNATION,
    ...overrides,
  };
}

async function rotationFixture(scope: 'user' | 'installation' = 'user') {
  const f = await handoffFixture(scope);
  const obs = new Database(':memory:');
  databases.push(obs);
  createAllSchemaTables(obs, observabilitySchema);
  f.env.OBSERVABILITY_DATABASE = createSqliteD1(obs);
  f.sqlite
    .prepare(
      "UPDATE nodes SET provider_instance_id = ?, runtime_incarnation_id = ? WHERE id = 'host'"
    )
    .run(INSTANCE, INCARNATION);

  /** Hetzner accounts: API token -> server id -> labels. */
  const accounts = new Map<string, Map<string, Record<string, string>>>([
    [ORIGINAL_TOKEN, new Map([[INSTANCE, samLabels()]])],
  ]);
  const gets: string[] = [];
  const deletes: string[] = [];
  const base = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const match = /api\.hetzner\.cloud\/v1\/servers\/(\d+)$/.exec(String(input));
      if (!match) return base(input, init);
      const id = match[1]!;
      const token =
        new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '') ?? '';
      if (token === 'revoked-key') {
        return Response.json(
          { error: { code: 'unauthorized', message: 'unable to authenticate' } },
          { status: 401 }
        );
      }
      const account = accounts.get(token);
      const labels = account?.get(id);
      if (init?.method === 'DELETE') {
        deletes.push(`${token}:${id}`);
        if (!labels) {
          return Response.json(
            { error: { code: 'not_found', message: 'Server not found' } },
            { status: 404 }
          );
        }
        account!.delete(id);
        return new Response(null, { status: 204 });
      }
      gets.push(`${token}:${id}`);
      if (!labels) {
        return Response.json(
          { error: { code: 'not_found', message: 'Server not found' } },
          { status: 404 }
        );
      }
      return Response.json({
        server: {
          id: Number(id),
          name: 'node-host',
          status: 'running',
          public_net: { ipv4: { ip: '192.0.2.77' } },
          server_type: { name: 'cx23', cores: 2, memory: 4, disk: 40 },
          location: { name: 'fsn1' },
          created: '2026-09-08T10:30:00.000Z',
          labels,
        },
      });
    })
  );

  const key = f.env.ENCRYPTION_KEY as string;
  const table = scope === 'installation' ? 'platform_credentials' : 'credentials';
  /** Re-encrypt `token` into every stored copy: same row IDs, new ciphertext generation. */
  async function regenerate(token = ORIGINAL_TOKEN) {
    const sealed = await encrypt(token, key);
    const at = new Date(NOW.getTime() - 60_000).toISOString();
    f.sqlite
      .prepare(`UPDATE ${table} SET encrypted_token = ?, iv = ?, updated_at = ?`)
      .run(sealed.ciphertext, sealed.iv, at);
    f.sqlite
      .prepare("UPDATE cc_credentials SET encrypted_token = ?, iv = ?, updated_at = ?")
      .run(sealed.ciphertext, sealed.iv, at);
  }
  /** Delete the user's cloud credential everywhere and save it again under a fresh ID. */
  async function replace(token = ORIGINAL_TOKEN, userId = 'user-1') {
    f.sqlite.exec(`DELETE FROM cc_attachments; DELETE FROM cc_configurations;
      DELETE FROM cc_credentials; DELETE FROM credentials WHERE credential_type = 'cloud-provider';`);
    const sealed = await encrypt(token, key);
    f.sqlite
      .prepare(
        `INSERT INTO credentials (id, user_id, project_id, provider, credential_type,
          credential_kind, is_active, encrypted_token, iv, created_at, updated_at)
        VALUES ('cloud-resaved', ?, NULL, 'hetzner', 'cloud-provider', 'api-key', 1, ?, ?, ?, ?)`
      )
      .run(userId, sealed.ciphertext, sealed.iv, NOW.toISOString(), NOW.toISOString());
  }
  const node = () =>
    f.sqlite
      .prepare(
        `SELECT status, runtime_termination_confirmed_at AS proof, cleanup_blocked_reason AS reason,
          cleanup_blocked_alerted_at AS alertedAt FROM nodes WHERE id = 'host'`
      )
      .get() as {
      status: string;
      proof: string | null;
      reason: string | null;
      alertedAt: string | null;
    };
  /** The operator ownership alert, apart from the cron's ordinary per-attempt failure rows. */
  const alerts = () =>
    obs
      .prepare(
        `SELECT message FROM platform_errors WHERE node_id = 'host' AND level = 'error'
          AND message LIKE 'VM may still exist at provider:%'`
      )
      .all() as Array<{ message: string }>;
  const sweep = async (at = NOW) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at);
    await runNodeCleanupSweep(f.env);
  };
  return { ...f, accounts, gets, deletes, regenerate, replace, node, alerts, sweep };
}

describe('cleanup cron tears a node down after its placement credential rotates', () => {
  it('control: an unrotated credential deletes through the pinned path without an ownership read', async () => {
    const f = await rotationFixture();

    await f.sweep();

    expect(f.deletes).toEqual([`${ORIGINAL_TOKEN}:${INSTANCE}`]);
    expect(f.gets).toEqual([]);
    expect(f.node()).toMatchObject({ status: 'deleted', proof: expect.any(String) });
  });

  it('a credential rotated in place (same row, new ciphertext generation) still tears down', async () => {
    const f = await rotationFixture();
    await f.regenerate();

    await f.sweep();

    expect(f.gets).toEqual([`${ORIGINAL_TOKEN}:${INSTANCE}`]);
    expect(f.deletes).toEqual([`${ORIGINAL_TOKEN}:${INSTANCE}`]);
    expect(f.node()).toMatchObject({ status: 'deleted', proof: expect.any(String) });
  });

  it('a credential deleted and saved again under a new row ID still tears down', async () => {
    const f = await rotationFixture();
    await f.replace();

    await f.sweep();

    expect(f.deletes).toEqual([`${ORIGINAL_TOKEN}:${INSTANCE}`]);
    expect(f.node()).toMatchObject({ status: 'deleted', proof: expect.any(String) });
  });

  it('a new API key for the same account (key rotation) still tears down', async () => {
    const f = await rotationFixture();
    f.accounts.set('rotated-key', f.accounts.get(ORIGINAL_TOKEN)!);
    await f.replace('rotated-key');

    await f.sweep();

    expect(f.deletes).toEqual([`rotated-key:${INSTANCE}`]);
    expect(f.node()).toMatchObject({ status: 'deleted' });
  });

  it.each([
    ['another installation sharing the provider account', { installation: 'f'.repeat(32) }],
    ['another environment', { env: 'production' }],
    ['another node', { node: '01m0000000000000000000other' }],
    ['another runtime incarnation', { incarnation: 'inc-replaced' }],
    ['a duplicated installation tag', { __sam_internal_ambiguous_label__installation: 'true' }],
  ])('preserves an instance labelled for %s', async (_name, overrides) => {
    const f = await rotationFixture();
    const labels = samLabels(overrides);
    if ('__sam_internal_ambiguous_label__installation' in overrides) delete labels.installation;
    f.accounts.get(ORIGINAL_TOKEN)!.set(INSTANCE, labels);
    await f.replace();

    await f.sweep();

    expect(f.gets).toEqual([`${ORIGINAL_TOKEN}:${INSTANCE}`]);
    expect(f.deletes).toEqual([]);
    expect(f.accounts.get(ORIGINAL_TOKEN)!.has(INSTANCE)).toBe(true);
    expect(f.node()).toMatchObject({
      proof: null,
      reason: expect.stringMatching(/^teardown_instance_ownership_mismatch/),
    });
  });

  it('preserves an instance that carries no SAM labels at all', async () => {
    const f = await rotationFixture();
    f.accounts.get(ORIGINAL_TOKEN)!.set(INSTANCE, {});
    await f.replace();

    await f.sweep();

    expect(f.deletes).toEqual([]);
    expect(f.node().reason).toMatch(/^teardown_instance_ownership_mismatch/);
  });

  it('blocks visibly, alerts once, does not spin, and keeps the reason across retries', async () => {
    const f = await rotationFixture();
    f.accounts.set('other-account', new Map());
    await f.replace('other-account');

    await f.sweep();
    expect(f.deletes).toEqual([]);
    expect(f.gets).toEqual([`other-account:${INSTANCE}`]);
    expect(f.node()).toMatchObject({
      proof: null,
      reason: expect.stringMatching(/^teardown_instance_not_visible/),
      alertedAt: expect.any(String),
    });
    expect(f.alerts()).toEqual([
      { message: expect.stringContaining(`VM may still exist at provider: hetzner ${INSTANCE}`) },
    ]);

    // Same tick again: the failure backoff keeps it out of the candidate set.
    await f.sweep();
    expect(f.gets).toHaveLength(1);
    expect(f.node().reason).toMatch(/^teardown_instance_not_visible/);

    // After the failure backoff the retry runs once (now past the blocked-retirement deadline, so
    // the stranded sweep forces it), fails the same way, and the named reason survives instead of
    // being replaced by the stranded sweep's catch-all.
    const config = resolveCleanupConfig(f.env);
    expect(config.failureBackoffMs).toBeGreaterThan(config.blockedRetirementMs);
    const retryAt = NOW.getTime() + config.failureBackoffMs + 60_000;
    await f.sweep(new Date(retryAt));
    expect(f.gets).toHaveLength(2);
    expect(f.deletes).toEqual([]);
    expect(f.node()).toMatchObject({
      proof: null,
      reason: expect.stringMatching(/^teardown_instance_not_visible/),
    });
    expect(f.alerts()).toHaveLength(1);

    // Past the deadline a named refusal still keeps its failure backoff: the next tick does not
    // read the provider again (the refusal backoff alone would have shrunk to zero).
    await f.sweep(new Date(retryAt + 6 * 60_000));
    expect(f.gets).toHaveLength(2);
    expect(f.node().reason).toMatch(/^teardown_instance_not_visible/);
  });

  it('the stranded-node deadline retry keeps the named reason instead of its catch-all', async () => {
    const f = await rotationFixture();
    f.accounts.set('other-account', new Map());
    await f.replace('other-account');
    await f.sweep();
    expect(f.node().reason).toMatch(/^teardown_instance_not_visible/);

    const config = resolveCleanupConfig(f.env);
    const at = new Date(NOW.getTime() + config.failureBackoffMs + 60_000);
    vi.setSystemTime(at);
    await sweepStrandedNodes(f.db, f.env, at, config, emptyResult());

    expect(f.gets).toHaveLength(2); // the stranded sweep really retried
    expect(f.deletes).toEqual([]);
    expect(f.node().reason).toMatch(/^teardown_instance_not_visible/);
  });

  it('a revoked current credential is a named "cannot see it" verdict, not a silent retry', async () => {
    const f = await rotationFixture();
    await f.replace('revoked-key');

    await f.sweep();

    expect(f.deletes).toEqual([]);
    expect(f.node()).toMatchObject({
      proof: null,
      reason: expect.stringMatching(/^teardown_instance_not_visible/),
      alertedAt: expect.any(String),
    });
  });

  it('an unreadable current credential is a retryable failure, not a "no credential" verdict', async () => {
    const f = await rotationFixture();
    await f.replace();
    f.sqlite.prepare("UPDATE credentials SET encrypted_token = 'corrupt'").run();
    f.sqlite.prepare("UPDATE cc_credentials SET encrypted_token = 'corrupt'").run();

    await f.sweep();

    expect(f.deletes).toEqual([]);
    expect(f.gets).toEqual([]);
    expect(f.node().proof).toBeNull();
    expect(f.node().reason ?? '').not.toMatch(/^teardown_/);
    expect(f.alerts()).toEqual([]);
  });

  it('keeps looking past a colliding foreign instance and deletes through the account that proves ownership', async () => {
    const f = await rotationFixture('installation');
    // The owner's personal account holds a different VM that happens to share the instance ID.
    f.accounts.set('personal-account', new Map([[INSTANCE, samLabels({ node: 'someone-else' })]]));
    const personal = await encrypt('personal-account', f.env.ENCRYPTION_KEY as string);
    f.sqlite
      .prepare(
        `INSERT INTO credentials (id, user_id, project_id, provider, credential_type,
          credential_kind, is_active, encrypted_token, iv, created_at, updated_at)
        VALUES ('personal', 'user-1', NULL, 'hetzner', 'cloud-provider', 'api-key', 1, ?, ?, ?, ?)`
      )
      .run(personal.ciphertext, personal.iv, NOW.toISOString(), NOW.toISOString());
    await f.regenerate();

    await f.sweep();

    expect(f.gets).toEqual([`personal-account:${INSTANCE}`, `${ORIGINAL_TOKEN}:${INSTANCE}`]);
    expect(f.deletes).toEqual([`${ORIGINAL_TOKEN}:${INSTANCE}`]);
    expect(f.accounts.get('personal-account')!.has(INSTANCE)).toBe(true);
    expect(f.node()).toMatchObject({ status: 'deleted' });
  });

  it('a node placed on the platform credential is reached after that credential rotates, even when its owner now has their own credential', async () => {
    const f = await rotationFixture('installation');
    // The owner adds a personal credential for a different account; provisioning order now
    // resolves it first, but it cannot see the platform-placed VM.
    f.accounts.set('personal-account', new Map());
    const personal = await encrypt('personal-account', f.env.ENCRYPTION_KEY as string);
    f.sqlite
      .prepare(
        `INSERT INTO credentials (id, user_id, project_id, provider, credential_type,
          credential_kind, is_active, encrypted_token, iv, created_at, updated_at)
        VALUES ('personal', 'user-1', NULL, 'hetzner', 'cloud-provider', 'api-key', 1, ?, ?, ?, ?)`
      )
      .run(personal.ciphertext, personal.iv, NOW.toISOString(), NOW.toISOString());
    await f.regenerate();

    await f.sweep();

    expect(f.deletes).toEqual([`${ORIGINAL_TOKEN}:${INSTANCE}`]);
    expect(f.node()).toMatchObject({ status: 'deleted' });
  });
});
