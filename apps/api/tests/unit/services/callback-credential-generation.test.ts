/**
 * The credential-generation check in `verifyCallbackToken`, against a real SQLite engine
 * with really signed RS256 tokens. Every callback sink inherits it, so these cases are the
 * contract: a token whose `cgen` differs from its row's `callback_generation` belongs to a
 * retired runtime and is refused, whatever the workspace's status.
 *
 * The Instant cases rotate through the real `persistRuntimeRecovering`, the write an
 * Instant wake or crash recovery commits; the VM restart/rebuild path is driven through
 * its real route in `tests/unit/routes/workspace-credential-generation-real-sql.test.ts`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { exportPKCS8, exportSPKI, generateKeyPair, importPKCS8, SignJWT } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import {
  loadRuntimeRecoveryContext,
  persistRuntimeRecovering,
} from '../../../src/durable-objects/vm-agent-container-recovery';
import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import {
  assertWorkspaceCallbackIdentityCurrent,
  loadWorkspaceCallbackIdentity,
} from '../../../src/routes/workspaces/_helpers';
import {
  signCallbackToken,
  signCurrentNodeCallbackToken,
  signCurrentWorkspaceCallbackToken,
  signNodeCallbackToken,
  verifyCallbackToken,
} from '../../../src/services/jwt';
import { collectSourceFiles, SRC_ROOT } from '../../helpers/source-tree';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const BASE_DOMAIN = 'example.test';
const USER = 'user-1';
const NODE = 'node-1';
const WS = 'ws-1';

let keys: { privateKey: string; publicKey: string };
let sqlite: Database.Database;
let env: Env;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  keys = {
    privateKey: await exportPKCS8(pair.privateKey),
    publicKey: await exportSPKI(pair.publicKey),
  };
});

beforeEach(() => {
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema as unknown as Record<string, unknown>);
  env = {
    DATABASE: createSqliteD1(sqlite),
    BASE_DOMAIN,
    JWT_PRIVATE_KEY: keys.privateKey,
    JWT_PUBLIC_KEY: keys.publicKey,
  } as unknown as Env;
});

afterEach(() => sqlite.close());

function seed(options: {
  runtime: 'vm' | 'cf-container';
  workspaceStatus: string;
  nodeStatus?: string;
  workspaceGeneration?: string | null;
  nodeGeneration?: string | null;
  incarnation?: string | null;
}): void {
  sqlite
    .prepare(
      `INSERT INTO nodes (id, user_id, name, status, runtime, runtime_incarnation_id, callback_generation)
       VALUES (?, ?, 'node', ?, ?, ?, ?)`
    )
    .run(
      NODE,
      USER,
      options.nodeStatus ?? options.workspaceStatus,
      options.runtime,
      options.incarnation ?? null,
      options.nodeGeneration ?? null
    );
  sqlite
    .prepare(
      `INSERT INTO workspaces (id, user_id, node_id, project_id, chat_session_id, name, status, callback_generation)
       VALUES (?, ?, ?, 'project-1', 'chat-1', 'ws', ?, ?)`
    )
    .run(WS, USER, NODE, options.workspaceStatus, options.workspaceGeneration ?? null);
}

async function verdict(token: string): Promise<number> {
  try {
    await verifyCallbackToken(token, env);
    return 200;
  } catch (err) {
    if (err instanceof AppError) return err.statusCode;
    throw err;
  }
}

/** A token with an arbitrary `cgen` value, signed exactly like the production signer. */
async function tokenWithRawGeneration(cgen: unknown): Promise<string> {
  const key = await importPKCS8(keys.privateKey, 'RS256');
  return new SignJWT({ workspace: WS, type: 'callback', scope: 'workspace', cgen })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(`https://api.${BASE_DOMAIN}`)
    .setSubject(WS)
    .setAudience('workspace-callback')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key);
}

describe('verifyCallbackToken — credential generation', () => {
  it('accepts the current generation and refuses a retired one while the workspace runs', async () => {
    seed({ runtime: 'vm', workspaceStatus: 'running', workspaceGeneration: 'gen-b' });
    expect(await verdict(await signCallbackToken(WS, env, { callbackGeneration: 'gen-b' }))).toBe(
      200
    );
    expect(await verdict(await signCallbackToken(WS, env, { callbackGeneration: 'gen-a' }))).toBe(
      401
    );
  });

  it('refuses a claimless token once the row has been rotated, and accepts it before', async () => {
    seed({ runtime: 'vm', workspaceStatus: 'running', workspaceGeneration: null });
    const legacy = await signCallbackToken(WS, env, { callbackGeneration: null });
    expect(await verdict(legacy)).toBe(200);
    sqlite.prepare("UPDATE workspaces SET callback_generation = 'gen-b'").run();
    expect(await verdict(legacy)).toBe(401);
  });

  it('refuses a generation claim on a row that was never rotated', async () => {
    seed({ runtime: 'vm', workspaceStatus: 'running', workspaceGeneration: null });
    expect(await verdict(await signCallbackToken(WS, env, { callbackGeneration: 'gen-x' }))).toBe(
      401
    );
  });

  it.each([
    ['empty string', ''],
    ['number', 7],
    ['object', { id: 'gen-b' }],
  ])('refuses a malformed generation claim (%s)', async (_label, cgen) => {
    seed({ runtime: 'vm', workspaceStatus: 'running', workspaceGeneration: 'gen-b' });
    expect(await verdict(await tokenWithRawGeneration(cgen))).toBe(401);
  });

  it('leaves a token naming a missing row to the sinks (their designed 410)', async () => {
    expect(
      await verdict(await signCallbackToken('ws-missing', env, { callbackGeneration: 'g' }))
    ).toBe(200);
  });

  it('checks node tokens against the node row, not the workspace row', async () => {
    seed({
      runtime: 'cf-container',
      workspaceStatus: 'running',
      workspaceGeneration: 'gen-b',
      nodeGeneration: 'gen-b',
    });
    expect(
      await verdict(await signNodeCallbackToken(NODE, env, { callbackGeneration: 'gen-b' }))
    ).toBe(200);
    sqlite.prepare("UPDATE nodes SET callback_generation = 'gen-c'").run();
    expect(
      await verdict(await signNodeCallbackToken(NODE, env, { callbackGeneration: 'gen-b' }))
    ).toBe(401);
    // The workspace token is unaffected by the node row.
    expect(await verdict(await signCallbackToken(WS, env, { callbackGeneration: 'gen-b' }))).toBe(
      200
    );
  });

  it('signs creation-time tokens for the row current generation', async () => {
    seed({
      runtime: 'vm',
      workspaceStatus: 'creating',
      workspaceGeneration: 'gen-b',
      nodeGeneration: null,
    });
    expect(await verdict(await signCurrentWorkspaceCallbackToken(WS, env))).toBe(200);
    expect(await verdict(await signCurrentNodeCallbackToken(NODE, env))).toBe(200);
  });
});

describe('Instant wake and recovery rotate both generations (persistRuntimeRecovering)', () => {
  async function recover(): Promise<{ workspace: string | null; node: string | null }> {
    const context = await loadRuntimeRecoveryContext(env, { workspaceId: WS });
    expect(context).not.toBeNull();
    const persisted = await persistRuntimeRecovering(env, {
      nodeId: NODE,
      workspaceId: WS,
      userId: USER,
      projectId: 'project-1',
      chatSessionId: 'chat-1',
      agentSessionId: 'agent-1',
      runtimeIncarnationId: context!.runtimeIncarnationId,
    });
    expect(persisted).not.toBeNull();
    const woken = await loadRuntimeRecoveryContext(env, { workspaceId: WS });
    return { workspace: woken!.workspaceCallbackGeneration, node: woken!.nodeCallbackGeneration };
  }

  beforeEach(() => {
    sqlite
      .prepare(
        `INSERT INTO agent_sessions (id, workspace_id, user_id, status, agent_type, runtime_contract_json)
         VALUES ('agent-1', ?, ?, 'running', 'claude-code', NULL)`
      )
      .run(WS, USER);
  });

  it.each([
    ['a never-rotated (pre-release) container', null],
    ['a previously woken container', 'incarnation-a'],
  ])('retires %s and accepts the woken one', async (_label, generationA) => {
    seed({
      runtime: 'cf-container',
      workspaceStatus: 'sleeping',
      incarnation: 'incarnation-a',
      workspaceGeneration: generationA,
      nodeGeneration: generationA,
    });
    const workspaceTokenA = await signCallbackToken(WS, env, { callbackGeneration: generationA });
    const nodeTokenA = await signNodeCallbackToken(NODE, env, { callbackGeneration: generationA });

    const generationB = await recover();
    expect(generationB.workspace).toEqual(expect.any(String));
    expect(generationB.workspace).not.toBe(generationA);
    expect(generationB.node).toBe(generationB.workspace);

    // The container's wake commit leaves the workspace active again.
    expect(sqlite.prepare('SELECT status FROM workspaces').get()).toEqual({ status: 'recovery' });
    expect(await verdict(workspaceTokenA)).toBe(401);
    expect(await verdict(nodeTokenA)).toBe(401);
    expect(
      await verdict(await signCallbackToken(WS, env, { callbackGeneration: generationB.workspace }))
    ).toBe(200);
    expect(
      await verdict(
        await signNodeCallbackToken(NODE, env, { callbackGeneration: generationB.node })
      )
    ).toBe(200);
  });

  it('a second recovery retires the first woken runtime too', async () => {
    seed({
      runtime: 'cf-container',
      workspaceStatus: 'running',
      incarnation: 'incarnation-a',
      workspaceGeneration: 'incarnation-a',
      nodeGeneration: 'incarnation-a',
    });
    const first = await recover();
    const firstToken = await signCallbackToken(WS, env, { callbackGeneration: first.workspace });
    sqlite.prepare("UPDATE workspaces SET status = 'running'").run();
    sqlite.prepare("UPDATE nodes SET status = 'running'").run();
    expect(await verdict(firstToken)).toBe(200);
    await recover();
    expect(await verdict(firstToken)).toBe(401);
  });
});

describe('callback identity fence (rule 49) sees a replaced runtime', () => {
  it('rejects a side effect authenticated against A when B now runs with identical statuses', async () => {
    seed({ runtime: 'vm', workspaceStatus: 'running', workspaceGeneration: 'gen-a' });
    const authenticatedAgainstA = await loadWorkspaceCallbackIdentity(env, WS);
    // A full restart cycle lands between authentication and the side effect.
    sqlite.prepare("UPDATE workspaces SET callback_generation = 'gen-b'").run();
    await expect(
      assertWorkspaceCallbackIdentityCurrent(env, authenticatedAgainstA!, 'messages')
    ).rejects.toMatchObject({ statusCode: 410 });
  });

  it('control: an unchanged runtime passes the fence', async () => {
    seed({ runtime: 'vm', workspaceStatus: 'running', workspaceGeneration: 'gen-a' });
    const current = await loadWorkspaceCallbackIdentity(env, WS);
    await expect(
      assertWorkspaceCallbackIdentityCurrent(env, current!, 'messages')
    ).resolves.toMatchObject({ callbackGeneration: 'gen-a' });
  });
});

describe('every callback credential is verified where the generation is checked', () => {
  // The generation check lives in verifyCallbackToken so that every sink inherits it.
  // A module that verified a callback JWT itself would silently skip it (rule 61).
  it('no source module outside services/jwt-verify.ts verifies a JWT signature', () => {
    const files = collectSourceFiles();
    expect(files.length).toBeGreaterThan(500);
    const verifiers = files.filter((file) => {
      const source = readFileSync(file, 'utf8');
      return /\bjwtVerify\s*\(/.test(source) || /\bcompactVerify\s*\(/.test(source);
    });
    // services/agent-sign-in/verify.ts verifies tokens from an EXTERNAL trusted issuer against
    // that issuer's published keys, with this instance's agent sign-in endpoint as the exact
    // audience and `type: workload-identity` required, so a SAM callback token cannot pass it.
    expect(verifiers.map((file) => path.relative(SRC_ROOT, file)).sort()).toEqual([
      'services/agent-sign-in/verify.ts',
      'services/jwt-verify.ts',
    ]);
  });
});
