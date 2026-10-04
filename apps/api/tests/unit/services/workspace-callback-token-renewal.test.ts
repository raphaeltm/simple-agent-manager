/**
 * Workspace callback token renewal and delivery against a real SQLite engine, with a D1
 * wrapper that can mutate the database between the reads a single call performs. This is
 * how the race cases are driven: a delete or move that lands after the binding was read
 * but before the credential leaves must suppress it (rule 49).
 *
 * Route-level behaviour (real Worker, real auth wiring) lives in
 * tests/workers/workspace-callback-token-renewal.test.ts.
 */
import Database from 'better-sqlite3';
import { decodeJwt, exportPKCS8, exportSPKI, generateKeyPair, importPKCS8, SignJWT } from 'jose';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { CALLBACK_TOKEN_GENERATION_ISSUED_AT_CLAIM } from '../../../src/services/callback-token-claims';
import { signNodeCallbackToken } from '../../../src/services/jwt';
import { mintWorkspaceCallbackTokenForNodeDelivery } from '../../../src/services/workspace-callback-token-binding';
import { renewWorkspaceCallbackToken } from '../../../src/services/workspace-callback-token-renewal';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const HOUR = 3600;
const DAY = 24 * HOUR;
const BASE_DOMAIN = 'example.com';
const USER = 'user-1';
const NODE = 'node-1';
const OTHER_NODE = 'node-2';
const WS = 'ws-1';

let privateKeyPem: string;
let publicKeyPem: string;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  privateKeyPem = await exportPKCS8(privateKey);
  publicKeyPem = await exportSPKI(publicKey);
});

let sqlite: Database.Database;
let onPrepare: ((sql: string) => void) | null;

function makeEnv(overrides: Partial<Record<string, string>> = {}): Env {
  const d1 = createSqliteD1(sqlite);
  const racing = new Proxy(d1, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return (sql: string) => {
          onPrepare?.(sql);
          return target.prepare(sql);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return {
    DATABASE: racing,
    BASE_DOMAIN,
    JWT_PRIVATE_KEY: privateKeyPem,
    JWT_PUBLIC_KEY: publicKeyPem,
    ...overrides,
  } as unknown as Env;
}

/** Same claim set as production signers, issued `ageSeconds` ago. */
async function agedToken(
  subject: string,
  scope: 'workspace' | 'node' | null,
  ageSeconds: number,
  lifetimeSeconds = DAY
): Promise<string> {
  const key = await importPKCS8(privateKeyPem, 'RS256');
  const issuedAt = Math.floor(Date.now() / 1000) - ageSeconds;
  return new SignJWT({ workspace: subject, type: 'callback', ...(scope ? { scope } : {}) })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(`https://api.${BASE_DOMAIN}`)
    .setSubject(subject)
    .setAudience('workspace-callback')
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + lifetimeSeconds)
    .sign(key);
}

function seed(): void {
  const insertNode = sqlite.prepare(
    'INSERT INTO nodes (id, user_id, name, status, runtime) VALUES (?, ?, ?, ?, ?)'
  );
  insertNode.run(NODE, USER, 'node-1', 'running', 'vm');
  insertNode.run(OTHER_NODE, USER, 'node-2', 'running', 'vm');
  sqlite
    .prepare(
      `INSERT INTO workspaces (id, user_id, node_id, project_id, chat_session_id, status, name)
       VALUES (?, ?, ?, NULL, NULL, 'running', 'ws')`
    )
    .run(WS, USER, NODE);
}

function bindingReadCount(): { count: number; mutateOn: (n: number, sql: string) => void } {
  const state = { count: 0, mutateOn: (_n: number, _sql: string) => undefined as void };
  onPrepare = (sql) => {
    if (sql.includes('FROM workspaces w') && sql.includes('LEFT JOIN nodes n')) {
      state.count += 1;
      state.mutateOn(state.count, sql);
    }
  };
  return state;
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [
    schema.workspaces,
    schema.nodes,
    schema.workspaceCallbackTokenRenewalRateLimits,
  ]);
  seed();
  onPrepare = null;
});

describe('mintWorkspaceCallbackTokenForNodeDelivery', () => {
  it('mints when the binding is unchanged across both reads', async () => {
    const reads = bindingReadCount();
    const token = await mintWorkspaceCallbackTokenForNodeDelivery(makeEnv(), {
      workspaceId: WS,
      nodeId: NODE,
    });
    expect(reads.count).toBe(2);
    expect(token).not.toBeNull();
    expect(decodeJwt(token as string)).toMatchObject({ workspace: WS, scope: 'workspace' });
  });

  it('withholds the token when the workspace is deleted after the first read', async () => {
    const reads = bindingReadCount();
    reads.mutateOn = (n) => {
      if (n === 2) sqlite.prepare("UPDATE workspaces SET status = 'deleted' WHERE id = ?").run(WS);
    };
    await expect(
      mintWorkspaceCallbackTokenForNodeDelivery(makeEnv(), { workspaceId: WS, nodeId: NODE })
    ).resolves.toBeNull();
  });

  it('withholds the token when the workspace moves to another node after the first read', async () => {
    const reads = bindingReadCount();
    reads.mutateOn = (n) => {
      if (n === 2)
        sqlite.prepare('UPDATE workspaces SET node_id = ? WHERE id = ?').run(OTHER_NODE, WS);
    };
    await expect(
      mintWorkspaceCallbackTokenForNodeDelivery(makeEnv(), { workspaceId: WS, nodeId: NODE })
    ).resolves.toBeNull();
  });

  it('withholds the token when the workspace is rebound to another chat session after the first read', async () => {
    const reads = bindingReadCount();
    reads.mutateOn = (n) => {
      if (n === 2) {
        sqlite.prepare("UPDATE workspaces SET chat_session_id = 'chat-2' WHERE id = ?").run(WS);
      }
    };
    await expect(
      mintWorkspaceCallbackTokenForNodeDelivery(makeEnv(), { workspaceId: WS, nodeId: NODE })
    ).resolves.toBeNull();
  });

  it('never delivers to an Instant (cf-container) runtime', async () => {
    sqlite.prepare("UPDATE nodes SET runtime = 'cf-container' WHERE id = ?").run(NODE);
    await expect(
      mintWorkspaceCallbackTokenForNodeDelivery(makeEnv(), { workspaceId: WS, nodeId: NODE })
    ).resolves.toBeNull();
  });

  it('returns null instead of throwing when the database read fails', async () => {
    onPrepare = () => {
      throw new Error('D1 unavailable');
    };
    await expect(
      mintWorkspaceCallbackTokenForNodeDelivery(makeEnv(), { workspaceId: WS, nodeId: NODE })
    ).resolves.toBeNull();
  });
});

describe('renewWorkspaceCallbackToken', () => {
  async function renew(
    workspaceToken: string,
    env: Env = makeEnv(),
    nodeToken?: string
  ): Promise<{ renewed: boolean; token?: string }> {
    return renewWorkspaceCallbackToken(env, {
      workspaceId: WS,
      workspaceToken,
      nodeId: NODE,
      nodeToken: nodeToken ?? (await signNodeCallbackToken(NODE, env)),
    });
  }

  async function rejection(promise: Promise<unknown>): Promise<AppError> {
    const error = await promise.then(
      () => null,
      (err: unknown) => err
    );
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }

  it('suppresses the renewed credential when the workspace is deleted while minting', async () => {
    const env = makeEnv();
    const nodeToken = await signNodeCallbackToken(NODE, env);
    onPrepare = (sql) => {
      // The identity re-read at the secret-delivery boundary is drizzle's select.
      if (sql.includes('from "workspaces"') && sql.includes('left join "nodes"')) {
        sqlite.prepare("UPDATE workspaces SET status = 'deleted' WHERE id = ?").run(WS);
      }
    };

    const error = await rejection(
      renew(await agedToken(WS, 'workspace', 13 * HOUR), env, nodeToken)
    );
    expect(error.statusCode).toBe(410);
  });

  it('suppresses the renewed credential when the workspace moves to another node while minting', async () => {
    const env = makeEnv();
    const nodeToken = await signNodeCallbackToken(NODE, env);
    onPrepare = (sql) => {
      if (sql.includes('from "workspaces"') && sql.includes('left join "nodes"')) {
        sqlite.prepare('UPDATE workspaces SET node_id = ? WHERE id = ?').run(OTHER_NODE, WS);
      }
    };

    const error = await rejection(
      renew(await agedToken(WS, 'workspace', 13 * HOUR), env, nodeToken)
    );
    expect([error.statusCode, error.error]).toEqual([410, 'GONE']);
    expect(sqlite.prepare('SELECT node_id FROM workspaces WHERE id = ?').get(WS)).toEqual({
      node_id: OTHER_NODE,
    });
  });

  it('ends renewal when the workspace is deleted before its attempt is counted', async () => {
    const env = makeEnv();
    const nodeToken = await signNodeCallbackToken(NODE, env);
    onPrepare = (sql) => {
      if (sql.includes('INSERT INTO workspace_callback_token_renewal_rate_limits')) {
        sqlite.prepare('DELETE FROM workspaces WHERE id = ?').run(WS);
      }
    };

    const error = await rejection(
      renew(await agedToken(WS, 'workspace', 13 * HOUR), env, nodeToken)
    );
    expect([error.statusCode, error.error]).toEqual([410, 'GONE']);
  });

  it('refuses an Instant (cf-container) workspace, while the VM control renews', async () => {
    const aged = await agedToken(WS, 'workspace', 13 * HOUR);
    expect((await renew(aged)).renewed).toBe(true);

    sqlite.prepare("UPDATE nodes SET runtime = 'cf-container' WHERE id = ?").run(NODE);
    const error = await rejection(renew(aged));
    expect([error.statusCode, error.error]).toEqual([403, 'FORBIDDEN']);
  });

  it('keeps the original generation of a legacy token without gen_iat', async () => {
    const aged = await agedToken(WS, 'workspace', 13 * HOUR);
    const result = await renew(aged);
    expect(result.renewed).toBe(true);
    expect(decodeJwt(result.token as string)[CALLBACK_TOKEN_GENERATION_ISSUED_AT_CLAIM]).toBe(
      decodeJwt(aged).iat
    );
  });

  it('rejects legacy unscoped tokens as either proof', async () => {
    const env = makeEnv();
    const legacyWorkspace = await agedToken(WS, null, 13 * HOUR);
    const legacyNode = await agedToken(NODE, null, HOUR);

    const asWorkspaceProof = await rejection(renew(legacyWorkspace, env));
    expect([asWorkspaceProof.statusCode, asWorkspaceProof.error]).toEqual([403, 'FORBIDDEN']);

    const asNodeProof = await rejection(
      renew(await agedToken(WS, 'workspace', 13 * HOUR), env, legacyNode)
    );
    expect([asNodeProof.statusCode, asNodeProof.error]).toEqual([403, 'NODE_CALLBACK_FORBIDDEN']);
  });

  it('renews up to the expiry boundary and never past it', async () => {
    const justValid = await agedToken(WS, 'workspace', DAY - 60);
    expect((await renew(justValid)).renewed).toBe(true);

    const justExpired = await agedToken(WS, 'workspace', DAY + 1);
    const error = await rejection(renew(justExpired));
    expect([error.statusCode, error.error]).toEqual([401, 'UNAUTHORIZED']);
  });

  it.each([
    ['unset (default 0.5)', undefined, 11, 13],
    ['unparseable (falls back to 0.5)', 'not-a-number', 11, 13],
    ['above the maximum (clamped to 0.9)', '0.99', 21, 22],
    ['below the minimum (clamped to 0.1)', '0', 2, 3],
  ])('applies the refresh ratio when %s', async (_label, ratio, notDueAgeHours, dueAgeHours) => {
    const env = makeEnv(
      ratio === undefined ? {} : { CALLBACK_TOKEN_REFRESH_THRESHOLD_RATIO: ratio }
    );
    expect(await renew(await agedToken(WS, 'workspace', notDueAgeHours * HOUR), env)).toEqual({
      renewed: false,
    });
    expect((await renew(await agedToken(WS, 'workspace', dueAgeHours * HOUR), env)).renewed).toBe(
      true
    );
  });
});
