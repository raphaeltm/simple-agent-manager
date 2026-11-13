import { beforeEach, expect, it, vi } from 'vitest';

import type { DeploymentPublishJobPorts } from '../../src/ports';

const cancel = vi.hoisted(() => vi.fn());
const info = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());
vi.mock('@simple-agent-manager/worker-core', async (load) => ({
  ...(await load<typeof import('@simple-agent-manager/worker-core')>()),
  log: { info, warn },
}));
const { cancelDeploymentPublishJobOnVmBestEffort } =
  await import('../../src/deployment-publish-job-cancel');
const job = { id: 'job', workspaceId: 'workspace', nodeId: 'node', requestedBy: 'owner' };
const resolveSetting = vi.fn(async () => 1000);
const ports: Pick<DeploymentPublishJobPorts, 'settings' | 'vm'> = {
  settings: { resolveSetting },
  vm: { cancelPublishJob: cancel },
};
beforeEach(() => {
  vi.clearAllMocks();
  resolveSetting.mockImplementation(async () => 1000);
});
it.each([404, 500])(
  'records bounded cancel failure status %s without response output',
  async (statusCode) => {
    cancel.mockRejectedValue(new Error(`VM agent returned ${statusCode}: private command output`));
    await expect(
      cancelDeploymentPublishJobOnVmBestEffort(ports, job, 123)
    ).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledWith('workspace', 'owner', 'node', 'job', 123);
    // An explicit timeout override skips the admin-settings read.
    expect(resolveSetting).not.toHaveBeenCalled();
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
it('uses the admin cancel timeout when no override is given', async () => {
  cancel.mockResolvedValue(undefined);
  resolveSetting.mockImplementation(async (name: string) =>
    name === 'deployments.publishJobCancelTimeoutMs' ? 4321 : 1
  );
  await cancelDeploymentPublishJobOnVmBestEffort(ports, job);
  expect(cancel).toHaveBeenCalledWith('workspace', 'owner', 'node', 'job', 4321);
});
