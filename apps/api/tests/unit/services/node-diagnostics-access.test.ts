/**
 * The shared node lookup is an ownership guard expressed as a SQL predicate, so it is tested
 * against a real SQL engine with an attack case and an owner-path control (`.claude/rules/28`).
 */
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import {
  findAccessibleNode,
  nodeAccessUserId,
  operatorNodeAccess,
  ownerNodeAccess,
  runNodeDiagnostic,
} from '../../../src/services/node-diagnostics-access';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

let env: Env;

beforeEach(() => {
  const sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [schema.nodes]);
  const insert = sqlite.prepare(
    'INSERT INTO nodes (id, user_id, name, status) VALUES (?, ?, ?, ?)'
  );
  insert.run('node-alice', 'alice', 'a', 'running');
  insert.run('node-bob', 'bob', 'b', 'running');
  insert.run('node-gone', 'alice', 'g', 'deleted');
  env = { DATABASE: createSqliteD1(sqlite) } as unknown as Env;
});

describe('findAccessibleNode', () => {
  it('owner path: a user sees their own node', async () => {
    expect((await findAccessibleNode(env, 'node-alice', ownerNodeAccess('alice')))?.id).toBe(
      'node-alice'
    );
  });

  it('attack: a user cannot reach another user’s node by ID', async () => {
    expect(await findAccessibleNode(env, 'node-bob', ownerNodeAccess('alice'))).toBeNull();
  });

  it('operator access reaches any user’s node, signed as the operator', async () => {
    const access = operatorNodeAccess({ userId: 'admin', taskId: 'task-1' });
    expect((await findAccessibleNode(env, 'node-bob', access))?.id).toBe('node-bob');
    expect(nodeAccessUserId(access)).toBe('admin');
  });

  it('deleted nodes are hidden from both owner and operator', async () => {
    expect(await findAccessibleNode(env, 'node-gone', ownerNodeAccess('alice'))).toBeNull();
    expect(
      await findAccessibleNode(
        env,
        'node-gone',
        operatorNodeAccess({ userId: 'admin', taskId: 't' })
      )
    ).toBeNull();
  });
});

describe('runNodeDiagnostic', () => {
  it('does not call a node that is not running', async () => {
    const call = vi.fn();
    const outcome = await runNodeDiagnostic(
      { id: 'n', status: 'stopped' },
      ownerNodeAccess('alice'),
      call
    );
    expect(outcome).toEqual({ status: 'not_running', nodeStatus: 'stopped' });
    expect(call).not.toHaveBeenCalled();
  });

  it('turns an agent failure into an unreachable outcome, and passes the signer through', async () => {
    const failing = await runNodeDiagnostic(
      { id: 'n', status: 'running' },
      ownerNodeAccess('alice'),
      () => Promise.reject(new Error('VM agent returned 503'))
    );
    expect(failing).toEqual({ status: 'unreachable', error: 'VM agent returned 503' });

    const call = vi.fn().mockResolvedValue({ ok: 1 });
    const ok = await runNodeDiagnostic(
      { id: 'n', status: 'running' },
      operatorNodeAccess({ userId: 'admin', taskId: 't' }),
      call
    );
    expect(ok).toEqual({ status: 'ok', value: { ok: 1 } });
    expect(call).toHaveBeenCalledWith('n', 'admin');
  });
});
