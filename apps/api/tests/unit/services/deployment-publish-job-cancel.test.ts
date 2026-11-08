import { beforeEach, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

const cancel = vi.hoisted(() => vi.fn());
const info = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());
vi.mock('../../../src/routes/mcp/workspace-tools', () => ({ cancelBuildPublishJobOnVm: cancel }));
vi.mock('../../../src/services/deployment-publish-job-settings', () => ({
  getDeploymentPublishJobSettings: async () => ({ cancelTimeoutMs: 1000 }),
}));
vi.mock('../../../src/lib/logger', () => ({ log: { info, warn } }));
const { cancelDeploymentPublishJobOnVmBestEffort } =
  await import('../../../src/services/deployment-publish-job-cancel');
const job = { id: 'job', workspaceId: 'workspace', nodeId: 'node', requestedBy: 'owner' };
beforeEach(() => {
  vi.clearAllMocks();
});
it.each([404, 500])(
  'records bounded cancel failure status %s without response output',
  async (statusCode) => {
    cancel.mockRejectedValue(new Error(`VM agent returned ${statusCode}: private command output`));
    await expect(
      cancelDeploymentPublishJobOnVmBestEffort({} as Env, job, 123)
    ).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledWith(
      expect.anything(),
      'workspace',
      'owner',
      'node',
      'job',
      123
    );
    const logger = statusCode === 404 ? info : warn;
    expect(logger).toHaveBeenCalledWith(expect.any(String), {
      publishJobId: 'job',
      nodeId: 'node',
      statusCode,
      errorType: 'Error',
    });
    expect(JSON.stringify([...info.mock.calls, ...warn.mock.calls])).not.toContain(
      'private command output'
    );
  }
);
