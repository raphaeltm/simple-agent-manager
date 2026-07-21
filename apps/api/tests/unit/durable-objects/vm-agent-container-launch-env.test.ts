import { describe, expect, it, vi } from 'vitest';

import { VmAgentContainer } from '../../../src/durable-objects/vm-agent-container';

// Regression coverage for the STANDALONE_CLONE_FILTER passthrough in
// VmAgentContainer.launch(): the operator-facing CF_CONTAINER_CLONE_FILTER
// Worker var must reach the container process env (where the vm-agent's
// config.Load reads it), and must be omitted entirely when unset so the
// vm-agent's own blob:none default applies. This exact spread was silently
// deleted by a concurrent working-tree write during review with zero test
// signal — this test closes that gap.

interface LaunchConfigInput {
  nodeId: string;
  workspaceId: string;
  projectId: string;
  chatSessionId: string;
  repository: string;
  branch: string;
  workspaceDir: string;
  controlPlaneUrl: string;
  vmAgentPort: number;
}

const launchConfig: LaunchConfigInput = {
  nodeId: 'node-1',
  workspaceId: 'ws-1',
  projectId: 'proj-1',
  chatSessionId: 'chat-1',
  repository: 'owner/repo',
  branch: 'main',
  workspaceDir: '/workspaces/repo',
  controlPlaneUrl: 'https://api.example.com',
  vmAgentPort: 8080,
};

function makeFake(env: Record<string, string | undefined>) {
  const startAndWaitForPorts = vi.fn().mockResolvedValue(undefined);
  const fake = {
    env,
    startAndWaitForPorts,
    startRuntime: (VmAgentContainer.prototype as unknown as { startRuntime: unknown }).startRuntime,
    clearKeepaliveSchedule: vi.fn().mockResolvedValue(undefined),
    getRuntimeSettings: () => ({ portReadyTimeoutMs: 30_000 }),
    ctx: {
      storage: {
        put: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
      },
    },
  };
  return { fake, startAndWaitForPorts };
}

function callLaunch(fake: unknown): Promise<void> {
  return (
    VmAgentContainer.prototype as unknown as {
      launch: (
        this: unknown,
        config: LaunchConfigInput,
        secrets: { nodeCallbackToken: string }
      ) => Promise<void>;
    }
  ).launch.call(fake, launchConfig, { nodeCallbackToken: 'node-token' });
}

function launchedEnvVars(startAndWaitForPorts: ReturnType<typeof vi.fn>): Record<string, string> {
  expect(startAndWaitForPorts).toHaveBeenCalledTimes(1);
  const [options] = startAndWaitForPorts.mock.calls[0] as [
    { startOptions: { envVars: Record<string, string> } },
  ];
  return options.startOptions.envVars;
}

describe('VmAgentContainer.launch env passthrough', () => {
  it('forwards CF_CONTAINER_CLONE_FILTER to the container as STANDALONE_CLONE_FILTER', async () => {
    const { fake, startAndWaitForPorts } = makeFake({ CF_CONTAINER_CLONE_FILTER: 'blob:limit=1m' });

    await callLaunch(fake);

    const envVars = launchedEnvVars(startAndWaitForPorts);
    expect(envVars.STANDALONE_CLONE_FILTER).toBe('blob:limit=1m');
    expect(envVars.NODE_ROLE).toBe('standalone');
    expect(envVars.CALLBACK_TOKEN).toBe('node-token');
  });

  it('omits STANDALONE_CLONE_FILTER when the Worker var is unset so the vm-agent default applies', async () => {
    const { fake, startAndWaitForPorts } = makeFake({});

    await callLaunch(fake);

    const envVars = launchedEnvVars(startAndWaitForPorts);
    expect(envVars).not.toHaveProperty('STANDALONE_CLONE_FILTER');
    expect(envVars.NODE_ROLE).toBe('standalone');
  });
});
