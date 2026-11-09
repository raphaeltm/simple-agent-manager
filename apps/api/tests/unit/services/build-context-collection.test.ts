import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../src/env';
import type { DeploymentPublishJobRow } from '../../../src/db/schema';
const fetch = vi.hoisted(() => vi.fn());
vi.mock('../../../src/services/node-agent', () => ({ fetchNodeAgent: fetch }));
vi.mock('../../../src/services/jwt', () => ({
  signNodeManagementToken: async () => ({ token: 'node-management' }),
}));
vi.mock('../../../src/services/admin-settings', () => ({
  resolveAdminSetting: async () => 120000,
}));
const { collectBuildContextOnSource } =
  await import('../../../src/services/build-context-collection');
const job = {
  id: 'job',
  workspaceId: 'ws',
  nodeId: 'node',
  requestedBy: 'user',
  attempt: 1,
  workingDir: '/workspaces/app',
} as DeploymentPublishJobRow;
describe('old-agent collection capability', () => {
  it('returns explicit unsupported on 404 without dispatching node builds', async () => {
    fetch.mockResolvedValue(new Response('{}', { status: 404 }));
    expect(
      await collectBuildContextOnSource({ BASE_DOMAIN: 'example.invalid' } as Env, job, {
        buildInterpolationEnv: { PUBLIC: 'value' },
        secretInterpolationKeys: ['PRIVATE'],
      })
    ).toMatchObject({ supported: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('fails genuine collection errors and accepts success', async () => {
    fetch.mockResolvedValue(new Response('{}', { status: 500 }));
    await expect(
      collectBuildContextOnSource({} as Env, job, {
        buildInterpolationEnv: {},
        secretInterpolationKeys: [],
      })
    ).rejects.toThrow('500');
    fetch.mockResolvedValue(new Response('{}', { status: 200 }));
    expect(
      await collectBuildContextOnSource({} as Env, job, {
        buildInterpolationEnv: {},
        secretInterpolationKeys: [],
      })
    ).toEqual({ supported: true });
  });
});
