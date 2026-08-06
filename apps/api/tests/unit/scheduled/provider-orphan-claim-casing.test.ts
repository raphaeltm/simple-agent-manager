/**
 * The claim lookup must survive the ULID case mismatch between D1 and provider labels.
 *
 * THE HAZARD
 *
 * `nodes.id` is stored UPPERCASE in D1 (verified against production: every live node
 * row satisfies `id = upper(id)`), but the provider label is written lowercased —
 * `node: node.id.toLowerCase()` in services/nodes.ts. The reconciler therefore has to
 * normalise before comparing.
 *
 * If it ever compares raw (`WHERE id IN (?)` with a lowercased label), the lookup
 * returns ZERO rows for EVERY node. Every live server then looks unclaimed, and the
 * reconciler — whose entire job is to destroy unclaimed servers — deletes the whole
 * fleet. At the time this was written that would have been all 9 production servers,
 * including three backing live customer deployments.
 *
 * The sibling suite (provider-orphan-reconciliation.test.ts) stubs D1 by hand and
 * cannot catch this: its stub ignores the SQL text entirely, so it passes with or
 * without `lower()`. This suite runs the query against real SQLite so the
 * normalisation is genuinely exercised.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { runProviderOrphanReconciliation } from '../../../src/scheduled/provider-orphan-reconciliation';
import { createSqliteD1 } from '../../helpers/sqlite-d1';

const deleteVM = vi.fn().mockResolvedValue(undefined);
const listVMs = vi.fn();

vi.mock('../../../src/services/platform-credentials', () => ({
  getPlatformCloudCredential: vi
    .fn()
    .mockResolvedValue({ decryptedToken: 'test-token', provider: 'hetzner' }),
}));
vi.mock('../../../src/services/provider-credentials', () => ({
  buildProviderConfig: vi.fn().mockReturnValue({ provider: 'hetzner', apiToken: 'test-token' }),
}));
vi.mock('@simple-agent-manager/providers', () => ({
  createProvider: vi.fn(() => ({ listVMs, deleteVM })),
}));
vi.mock('../../../src/lib/secrets', () => ({
  getCredentialEncryptionKey: vi.fn().mockReturnValue('key'),
}));
vi.mock('../../../src/services/observability', () => ({
  persistError: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let sqlite: Database.Database | null = null;

/** Stored in D1 exactly as production stores it: uppercase. */
const LIVE_NODE_ID = '01KZ9YVQSEWC18H9DDC26PRXCT';
const DELETED_NODE_ID = '01KZA0A8MCJFTNMDWE77PWGQWK';
const UNKNOWN_NODE_ID = '01KX84MCG1YN1TQVWR60B3G70A';

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const HOUR = 60 * 60 * 1000;

function serverFor(nodeId: string, serverId: string) {
  return {
    id: serverId,
    name: `node-${nodeId.toLowerCase()}`,
    ip: '1.2.3.4',
    status: 'running',
    serverType: 'cx22',
    createdAt: ago(4 * HOUR),
    labels: {
      managed: 'simple-agent-manager',
      // Lowercased, exactly as services/nodes.ts writes it.
      node: nodeId.toLowerCase(),
      role: 'workspace',
      env: 'production',
    },
  };
}

function makeEnv(): Env {
  return {
    ENVIRONMENT: 'production',
    KV: { get: vi.fn().mockResolvedValue(null), put: vi.fn().mockResolvedValue(undefined) },
    DATABASE: createSqliteD1(sqlite as Database.Database),
    OBSERVABILITY_DATABASE: createSqliteD1(sqlite as Database.Database),
  } as unknown as Env;
}

beforeEach(() => {
  deleteVM.mockClear();
  listVMs.mockReset();
  sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL,
      node_role TEXT NOT NULL DEFAULT 'workspace', node_class TEXT NOT NULL DEFAULT 'managed',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  const insert = sqlite.prepare(
    `INSERT INTO nodes (id, user_id, name, status, created_at, updated_at)
     VALUES (?, 'user-1', ?, ?, ?, ?)`
  );
  insert.run(LIVE_NODE_ID, 'live', 'running', ago(5 * HOUR), ago(1000));
  insert.run(DELETED_NODE_ID, 'gone', 'deleted', ago(5 * HOUR), ago(1000));
});

afterEach(() => {
  sqlite?.close();
  sqlite = null;
  vi.clearAllMocks();
});

describe('provider orphan claim lookup — ULID casing', () => {
  it('does NOT destroy a server whose UPPERCASE node row is alive (lowercased label)', async () => {
    // The regression guard. Comparing raw instead of normalising returns no row here,
    // the live node reads as unclaimed, and its server is destroyed.
    listVMs.mockResolvedValue([serverFor(LIVE_NODE_ID, 'srv-live')]);

    const result = await runProviderOrphanReconciliation(makeEnv());

    expect(deleteVM).not.toHaveBeenCalled();
    expect(result.skippedClaimed).toBe(1);
    expect(result.destroyed).toBe(0);
  });

  it('still destroys a server whose node row is terminally deleted', async () => {
    // Positive control: proves the lookup is reached and CAN authorise a destroy, so
    // the assertion above is not passing merely because nothing ever matches.
    listVMs.mockResolvedValue([serverFor(DELETED_NODE_ID, 'srv-deleted')]);

    const result = await runProviderOrphanReconciliation(makeEnv());

    expect(deleteVM).toHaveBeenCalledWith('srv-deleted');
    expect(result.destroyed).toBe(1);
  });

  it('destroys a server with no node row at all', async () => {
    listVMs.mockResolvedValue([serverFor(UNKNOWN_NODE_ID, 'srv-unknown')]);

    const result = await runProviderOrphanReconciliation(makeEnv());

    expect(deleteVM).toHaveBeenCalledWith('srv-unknown');
    expect(result.destroyed).toBe(1);
  });

  it('resolves a MIXED batch correctly in a single lookup', async () => {
    // The realistic shape: one live, one deleted, one unknown. A batched IN-clause
    // lookup must map each server to its OWN row rather than applying one verdict to
    // the whole batch.
    listVMs.mockResolvedValue([
      serverFor(LIVE_NODE_ID, 'srv-live'),
      serverFor(DELETED_NODE_ID, 'srv-deleted'),
      serverFor(UNKNOWN_NODE_ID, 'srv-unknown'),
    ]);

    const result = await runProviderOrphanReconciliation(makeEnv());

    expect(deleteVM).toHaveBeenCalledWith('srv-deleted');
    expect(deleteVM).toHaveBeenCalledWith('srv-unknown');
    expect(deleteVM).not.toHaveBeenCalledWith('srv-live');
    expect(result.destroyed).toBe(2);
    expect(result.skippedClaimed).toBe(1);
  });
});
