import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { fetchVmAgentContainer } from '../../../src/services/vm-agent-container';

function containerEnv() {
  const stub = {
    fetch: vi.fn(),
    proxyHttp: vi.fn().mockResolvedValue(new Response('plain')),
    proxyHttpGuarded: vi.fn().mockResolvedValue(new Response('guarded')),
    proxyHttpNoWake: vi.fn().mockResolvedValue(new Response('no-wake')),
  };
  const get = vi.fn(() => stub);
  const idFromName = vi.fn(() => ({ toString: () => 'container-id' }));
  const env = {
    CF_CONTAINER_ENABLED: 'true',
    VM_AGENT_CONTAINER: { get, idFromName },
  } as unknown as Env;
  return { env, stub };
}

describe('fetchVmAgentContainer source-task guard', () => {
  it('selects the guarded DO RPC for an authorized orchestration request', async () => {
    const { env, stub } = containerEnv();
    const request = new Request('http://localhost/prompt', { method: 'POST' });
    const guard = {
      taskId: 'parent-1',
      projectId: 'project-1',
      chatSessionId: 'chat-1',
    };

    await expect(
      fetchVmAgentContainer(env, 'node-1', request, 8080, guard)
    ).resolves.toBeInstanceOf(Response);

    expect(stub.proxyHttpGuarded).toHaveBeenCalledWith(request, 8080, guard);
    expect(stub.proxyHttp).not.toHaveBeenCalled();
  });

  it('selects the dedicated no-wake DO RPC without entering the ordinary proxy', async () => {
    const { env, stub } = containerEnv();
    const request = new Request('http://localhost/capabilities');

    const { fetchVmAgentContainerNoWake } =
      await import('../../../src/services/vm-agent-container');
    await fetchVmAgentContainerNoWake(env, 'node-1', request, 8080);

    expect(stub.proxyHttpNoWake).toHaveBeenCalledWith(request, 8080);
    expect(stub.proxyHttp).not.toHaveBeenCalled();
    expect(stub.proxyHttpGuarded).not.toHaveBeenCalled();
  });

  it('preserves the ordinary proxy path when no source guard exists', async () => {
    const { env, stub } = containerEnv();
    const request = new Request('http://localhost/capabilities');

    await fetchVmAgentContainer(env, 'node-1', request, 8080);

    expect(stub.proxyHttp).toHaveBeenCalledWith(request, 8080);
    expect(stub.proxyHttpGuarded).not.toHaveBeenCalled();
  });
});
