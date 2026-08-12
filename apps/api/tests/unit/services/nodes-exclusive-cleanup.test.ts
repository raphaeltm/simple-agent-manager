import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({
  destroyVmAgentContainer: vi.fn(),
}));

vi.mock('../../../src/services/vm-agent-container', () => ({
  destroyVmAgentContainer: (...args: unknown[]) => mocks.destroyVmAgentContainer(...args),
}));

vi.mock('../../../src/services/provider-credentials', () => ({
  createProviderForUser: vi.fn(),
}));

vi.mock('../../../src/services/dns', () => ({
  createNodeBackendDNSRecord: vi.fn(),
  deleteDNSRecord: vi.fn(),
}));

import { stopNodeResources } from '../../../src/services/nodes';

let sqlite: Database.Database;
let env: Env;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.destroyVmAgentContainer.mockResolvedValue(undefined);
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [schema.nodes, schema.workspaces]);
  env = { DATABASE: createSqliteD1(sqlite) } as unknown as Env;
});

afterEach(() => {
  sqlite.close();
});

function db() {
  return drizzle(env.DATABASE, { schema });
}

async function seedCfContainerClaimedWorkspace(): Promise<void> {
  await db().insert(schema.nodes).values({
    id: 'node-exclusive',
    userId: 'user-owner',
    name: 'node-exclusive',
    status: 'running',
    runtime: 'cf-container',
    nodeRole: 'workspace',
    nodeClass: 'managed',
  } as typeof schema.nodes.$inferInsert);
  await db().insert(schema.workspaces).values({
    id: 'ws-claimed',
    nodeId: 'node-exclusive',
    userId: 'user-owner',
    projectId: 'project-owner',
    name: 'ws-claimed',
    repository: 'org/repo',
    vmSize: 'small',
    vmLocation: 'nbg1',
    status: 'stopping',
  } as typeof schema.workspaces.$inferInsert);
}

describe('stopNodeResources exclusive cf-container cleanup boundary', () => {
  it('ATTACK: sibling inserted after outer precheck blocks container destruction', async () => {
    await seedCfContainerClaimedWorkspace();
    await db().insert(schema.workspaces).values({
      id: 'ws-racing-sibling',
      nodeId: 'node-exclusive',
      userId: 'user-owner',
      projectId: 'project-owner',
      name: 'ws-racing-sibling',
      repository: 'org/repo',
      vmSize: 'small',
      vmLocation: 'nbg1',
      status: 'running',
    } as typeof schema.workspaces.$inferInsert);

    await expect(
      stopNodeResources('node-exclusive', 'user-owner', env, {
        exclusiveWorkspaceId: 'ws-claimed',
      })
    ).rejects.toThrow(/not exclusive/);

    expect(mocks.destroyVmAgentContainer).not.toHaveBeenCalled();
    const node = sqlite.prepare(`SELECT status FROM nodes WHERE id = ?`).get('node-exclusive') as {
      status: string;
    };
    expect(node.status).toBe('running');
  });

  it('CONTROL: no sibling allows exclusive container destruction and scoped workspace deletion', async () => {
    await seedCfContainerClaimedWorkspace();

    await stopNodeResources('node-exclusive', 'user-owner', env, {
      exclusiveWorkspaceId: 'ws-claimed',
    });

    expect(mocks.destroyVmAgentContainer).toHaveBeenCalledWith(env, 'node-exclusive');
    const workspace = sqlite
      .prepare(`SELECT status FROM workspaces WHERE id = ?`)
      .get('ws-claimed') as { status: string };
    const node = sqlite.prepare(`SELECT status FROM nodes WHERE id = ?`).get('node-exclusive') as {
      status: string;
    };
    expect(workspace.status).toBe('deleted');
    expect(node.status).toBe('deleted');
  });
});
