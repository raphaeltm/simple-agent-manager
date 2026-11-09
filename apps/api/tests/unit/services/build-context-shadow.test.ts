import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import type { McpTokenData } from '../../../src/routes/mcp/_helpers';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';
const mock = vi.hoisted(() => ({
  mode: 'off',
  fetch: vi.fn(async () => new Response('{}', { status: 202 })),
  start: vi.fn(async () => undefined),
  id: 0,
  lifecycle: vi.fn(async () => undefined),
}));
vi.mock('../../../src/services/admin-settings', () => ({
  resolveAdminSetting: async (_env: unknown, key: string) =>
    key.endsWith('CollectionMode') ? mock.mode : key.endsWith('MaxBytes') ? 2147483648 : 10000,
}));
vi.mock('../../../src/lib/ulid', () => ({ ulid: () => `id${++mock.id}` }));
vi.mock('../../../src/services/node-agent', () => ({ fetchNodeAgent: mock.fetch }));
vi.mock('../../../src/services/jwt', () => ({
  signNodeManagementToken: async () => ({ token: 'real-control-path-test' }),
}));
vi.mock('../../../src/services/deployment-control', () => ({
  assertAgentDeploymentAllowed: async () => ({
    environmentId: 'env',
    taskAgentProfileId: 'profile',
  }),
}));
vi.mock('../../../src/services/deployment-environment-config', () => ({
  loadDeploymentBuildInterpolationEnv: async () => ({
    values: { PUBLIC: 'yes' },
    secretKeys: ['PRIVATE'],
  }),
}));
vi.mock('../../../src/services/project-lifecycle-events', () => ({
  recordDeploymentPublishJobLifecycleEventBestEffort: mock.lifecycle,
}));
vi.mock('../../../src/routes/mcp/workspace-tools', async (original) => ({
  ...(await original<typeof import('../../../src/routes/mcp/workspace-tools')>()),
  requireWorkspace: () => null,
  lookupWorkspaceForVmAgent: async () => ({ id: 'ws', nodeId: 'node', projectId: 'project' }),
  startBuildPublishJobOnVm: mock.start,
}));
const { handleBuildAndPublish } = await import('../../../src/routes/mcp/compose-publish-tools');
const { getDeploymentPublishJobForMcp, cancelDeploymentPublishJob } =
  await import('../../../src/services/deployment-publish-jobs');
const { drizzle } = await import('drizzle-orm/d1');
let sqlite: Database.Database;
let env: Env;
const actor = {
  projectId: 'project',
  workspaceId: 'ws',
  userId: 'user',
  taskId: 'task',
} as McpTokenData;
let pending: Promise<unknown>[];
const ctx = {
  waitUntil: (p: Promise<unknown>) => {
    pending.push(p);
  },
};
const publish = (withContext = true) =>
  handleBuildAndPublish(
    'request',
    { environment: 'staging', workingDir: '/workspaces/app' },
    actor,
    env,
    withContext ? ctx : undefined
  );
beforeEach(() => {
  vi.clearAllMocks();
  mock.id = 0;
  mock.mode = 'off';
  pending = [];
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [
    schema.deploymentPublishJobs,
    schema.deploymentPublishJobEvents,
    schema.nodes,
  ]);
  sqlite.exec("INSERT INTO nodes(id,runtime) VALUES('node','vm')");
  env = { DATABASE: createSqliteD1(sqlite), BASE_DOMAIN: 'staging.invalid' } as Env;
  mock.fetch.mockResolvedValue(new Response('{}', { status: 202 }));
});
afterEach(() => sqlite.close());
describe('shadow collection through the real publish handler', () => {
  it('off mode has byte-identical public response and node start payload to the original path', async () => {
    const baseline = await publish(false);
    const payload = mock.start.mock.calls.map((call) => [...call]);
    sqlite.exec('DELETE FROM deployment_publish_job_events; DELETE FROM deployment_publish_jobs');
    mock.id = 0;
    mock.start.mockClear();
    const off = await publish();
    await Promise.all(pending);
    expect(off).toEqual(baseline);
    expect(mock.start.mock.calls).toEqual(payload);
    expect(mock.fetch).not.toHaveBeenCalled();
    expect(
      sqlite.prepare('SELECT executor,context_shadow FROM deployment_publish_jobs').all()
    ).toEqual([{ executor: 'node', context_shadow: 0 }]);
  });
  it('shadow kickoff cannot delay or fail the real node publish', async () => {
    mock.mode = 'shadow';
    let accept!: (r: Response) => void;
    mock.fetch.mockImplementationOnce(
      () =>
        new Promise((r) => {
          accept = r;
        })
    );
    const result = await publish();
    expect(result.error).toBeUndefined();
    expect(mock.start).toHaveBeenCalledTimes(1);
    while (!accept) await Promise.resolve();
    accept(new Response('{}', { status: 500 }));
    await Promise.all(pending);
    expect(
      sqlite.prepare('SELECT status FROM deployment_publish_jobs WHERE context_shadow=0').get()
    ).toEqual({ status: 'starting' });
    expect(
      sqlite
        .prepare('SELECT status,release_id FROM deployment_publish_jobs WHERE context_shadow=1')
        .get()
    ).toEqual({ status: 'failed', release_id: null });
  });
  it('Instant shadow collects via a workspace JWT while retaining the early node-build gate', async () => {
    mock.mode = 'shadow';
    sqlite.exec("UPDATE nodes SET runtime='cf-container'");
    const result = await publish();
    await Promise.all(pending);
    expect(result.error?.message).toContain("Instant sessions isn't available");
    expect(mock.start).not.toHaveBeenCalled();
    expect(mock.fetch).toHaveBeenCalledTimes(1);
    const request = mock.fetch.mock.calls[0] as unknown as [string, Env, string, RequestInit];
    const body = JSON.parse(String(request[3].body));
    expect(body).toMatchObject({
      shadow: true,
      attempt: 1,
      workingDir: '/workspaces/app',
      secretInterpolationKeys: ['PRIVATE'],
    });
    expect(body).not.toHaveProperty('PRIVATE');
    expect(
      sqlite.prepare('SELECT executor,context_shadow FROM deployment_publish_jobs').all()
    ).toEqual([{ executor: 'cloudflare', context_shadow: 1 }]);
  });
  it('hides shadow jobs from status and user cancel reads, with normal owner controls', async () => {
    mock.mode = 'shadow';
    await publish();
    await Promise.all(pending);
    const db = drizzle(env.DATABASE, { schema });
    const rows = sqlite.prepare('SELECT id,context_shadow FROM deployment_publish_jobs').all() as {
      id: string;
      context_shadow: number;
    }[];
    for (const row of rows) {
      const status = await getDeploymentPublishJobForMcp(db, 'project', row.id);
      if (row.context_shadow) {
        expect(status).toBeNull();
        expect(await cancelDeploymentPublishJob(db, 'project', 'ws', row.id)).toBeNull();
      } else expect(status).not.toBeNull();
    }
  });
});
