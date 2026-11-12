/**
 * The worker's app-deployment port adapters must hand every argument to the
 * worker function they wrap, in order. userId and nodeId are both strings, so a
 * swapped argument would compile.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/env';

const cancelBuildPublishJobOnVm = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const resolveAdminSetting = vi.hoisted(() => vi.fn(async () => 42));
const recordLifecycle = vi.hoisted(() => vi.fn(async () => undefined));
const createProviderForUser = vi.hoisted(() => vi.fn(async () => null));
const encrypt = vi.hoisted(() => vi.fn(async () => ({ ciphertext: 'c', iv: 'i' })));
const decrypt = vi.hoisted(() => vi.fn(async () => 'plain'));

vi.mock('../../src/routes/mcp/workspace-tools', () => ({ cancelBuildPublishJobOnVm }));
vi.mock('../../src/services/admin-settings', () => ({ resolveAdminSetting }));
vi.mock('../../src/services/project-lifecycle-events', () => ({
  recordDeploymentPublishJobLifecycleEventBestEffort: recordLifecycle,
}));
vi.mock('../../src/services/provider-credentials', () => ({ createProviderForUser }));
vi.mock('../../src/services/encryption', () => ({ encrypt, decrypt }));

const { createDeploymentPublishJobPorts } =
  await import('../../src/app-deployment-ports/publish-jobs');
const { createDeploymentProviderPort } = await import('../../src/app-deployment-ports/providers');
const { createDeploymentSecretCipher } =
  await import('../../src/app-deployment-ports/secret-cipher');

const env = { CREDENTIAL_ENCRYPTION_KEY: 'credential-key' } as unknown as Env;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createDeploymentPublishJobPorts', () => {
  it('passes VM cancel arguments through in order with the worker env', async () => {
    const ports = createDeploymentPublishJobPorts(env);
    await ports.vm.cancelPublishJob('workspace-1', 'user-1', 'node-1', 'job-1', 1234);
    expect(cancelBuildPublishJobOnVm).toHaveBeenCalledWith(
      env,
      'workspace-1',
      'user-1',
      'node-1',
      'job-1',
      1234
    );
  });

  it('resolves the named admin setting against the worker env', async () => {
    const ports = createDeploymentPublishJobPorts(env);
    await expect(
      ports.settings.resolveSetting('deployments.publishJobCancelTimeoutMs')
    ).resolves.toBe(42);
    expect(resolveAdminSetting).toHaveBeenCalledWith(env, 'deployments.publishJobCancelTimeoutMs');
  });

  it('records publish-job lifecycle events against the worker env', async () => {
    const ports = createDeploymentPublishJobPorts(env);
    const event = {
      projectId: 'project-1',
      publishJobId: 'job-1',
      environmentId: 'env-1',
      status: 'failed',
      terminal: true,
      source: 'test',
    };
    await ports.lifecycle.recordPublishJobLifecycleEventBestEffort(event);
    expect(recordLifecycle).toHaveBeenCalledWith(env, event);
  });
});

describe('createDeploymentProviderPort', () => {
  it('resolves providers with the credential encryption key and the caller scope', async () => {
    const db = {} as Parameters<
      ReturnType<typeof createDeploymentProviderPort>['createProviderForUser']
    >[0];
    await createDeploymentProviderPort(env).createProviderForUser(
      db,
      'user-1',
      'hetzner',
      'project-1'
    );
    expect(createProviderForUser).toHaveBeenCalledWith(
      db,
      'user-1',
      'credential-key',
      env,
      'hetzner',
      'project-1'
    );
  });
});

describe('createDeploymentSecretCipher', () => {
  it('binds encryption and decryption to the key it was created with', async () => {
    const cipher = createDeploymentSecretCipher('bound-key');
    await cipher.encrypt('secret');
    await cipher.decrypt('ciphertext', 'iv');
    expect(encrypt).toHaveBeenCalledWith('secret', 'bound-key');
    expect(decrypt).toHaveBeenCalledWith('ciphertext', 'iv', 'bound-key');
  });
});
