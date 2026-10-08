import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import { persistRuntimeEnded } from '../../src/durable-objects/vm-agent-container-runtime';
import type { Env } from '../../src/env';
import { runNodeCleanupSweep } from '../../src/scheduled/node-cleanup';
import { stopNodeResources } from '../../src/services/node-resource-lifecycle';
import {
  seedAgentSession,
  seedInstallation,
  seedNode,
  seedProject,
  seedTask,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';

async function seedInstant(status: 'sleeping' | 'running') {
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  await seedUser('instant-user');
  await seedInstallation('instant-install', 'instant-user');
  await seedProject('instant-project', 'instant-user', 'instant-install');
  await seedNode('instant-node', 'instant-user', { status, createdAt: old, updatedAt: old });
  await env.DATABASE.prepare(
    "UPDATE nodes SET runtime = 'cf-container' WHERE id = 'instant-node'"
  ).run();
  await seedWorkspace('instant-workspace', 'instant-node', 'instant-user', {
    status,
    projectId: 'instant-project',
    chatSessionId: 'instant-chat',
    createdAt: old,
    updatedAt: old,
  });
  await seedAgentSession('instant-agent', 'instant-workspace', 'instant-user', { status });
  await seedTask('instant-task', 'instant-project', 'instant-user', {
    status: 'in_progress',
    workspaceId: 'instant-workspace',
    autoProvisionedNodeId: 'instant-node',
    updatedAt: old,
  });
}

const node = () =>
  env.DATABASE.prepare(
    "SELECT status, runtime_termination_confirmed_at FROM nodes WHERE id = 'instant-node'"
  ).first();

describe('Instant lifecycle on Workers D1', () => {
  it('preserves the sleeping wake target through the entire scheduled cleanup sweep past 48 hours', async () => {
    await seedInstant('sleeping');
    const destroyForUser = vi.fn().mockResolvedValue(undefined);
    const testEnv = {
      ...env,
      CF_CONTAINER_ENABLED: 'true',
      VM_AGENT_CONTAINER: {
        idFromName: (id: string) => id,
        get: () => ({ destroyForUser }),
      },
    } as unknown as Env;
    await runNodeCleanupSweep(testEnv);
    expect(destroyForUser).not.toHaveBeenCalled();
    expect(await node()).toMatchObject({
      status: 'sleeping',
      runtime_termination_confirmed_at: null,
    });
    expect(
      await env.DATABASE.prepare(
        "SELECT status FROM workspaces WHERE id = 'instant-workspace'"
      ).first()
    ).toEqual({ status: 'sleeping' });
  });
  it('records strict teardown proof when the real onStop persistence runs inside destroy', async () => {
    await seedInstant('running');
    const testEnv = {
      ...env,
      CF_CONTAINER_ENABLED: 'true',
      VM_AGENT_CONTAINER: {
        idFromName: (id: string) => id,
        get: () => ({
          destroyForUser: async () => {
            await persistRuntimeEnded(
              testEnv,
              { nodeId: 'instant-node', workspaceId: 'instant-workspace' },
              'stopped',
              'Stopped'
            );
            expect(await node()).toMatchObject({ status: 'destroying' });
          },
        }),
      },
    } as unknown as Env;
    await stopNodeResources('instant-node', 'instant-user', testEnv);
    expect(await node()).toMatchObject({
      status: 'deleted',
      runtime_termination_confirmed_at: expect.any(String),
    });
  });
});
