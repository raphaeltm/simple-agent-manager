import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/jwt', () => ({
  signNodeManagementToken: async () => ({ token: 'management-secret' }),
}));
vi.mock('../../../src/services/telemetry', () => ({ recordNodeRoutingMetric: vi.fn() }));

import { probeLiveRuntimeSession } from '../../../src/durable-objects/vm-agent-container-runtime';
import type { Env } from '../../../src/env';
import { nodeAgentRequest } from '../../../src/services/node-agent';
import { probeNodeHealthForTaskLiveness } from '../../../src/services/task-runtime-liveness-node-probe';

const env = { BASE_DOMAIN: 'example.com' } as Env;
afterEach(() => vi.unstubAllGlobals());

describe('node redirect boundary', () => {
  it.each([200, 307])('treats node status %s without following its Location', async (status) => {
    const requests: Request[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const request = new Request(url, init);
      requests.push(request);
      // Simulate the actual runtime follow default; red without explicit manual.
      if (status === 307 && request.redirect !== 'manual') {
        requests.push(new Request('https://unvetted.example/steal', init));
        return Response.json({ followed: true });
      }
      return Response.json(
        { healthy: true },
        { status, headers: { location: 'https://unvetted.example/steal?token=management-secret' } }
      );
    });
    if (status === 200) {
      await expect(
        nodeAgentRequest('node', env, '/workspaces', { userId: 'user' })
      ).resolves.toEqual({ healthy: true });
    } else {
      await expect(
        nodeAgentRequest('node', env, '/workspaces', { userId: 'user', redirect: 'follow' })
      ).rejects.toThrow('307');
    }
    expect(requests).toHaveLength(1);
    expect(requests[0]?.redirect).toBe('manual');
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer management-secret');
  });

  it.each([200, 307])(
    'live container session probe handles %s without following JWT',
    async (status) => {
      const containerFetch = vi.fn(async (request: Request) => {
        if (status === 307 && request.redirect !== 'manual')
          return Response.json({ sessions: [{ id: 'session', hostStatus: 'ready' }] });
        return Response.json(
          { sessions: [{ id: 'session', hostStatus: 'ready' }] },
          { status, headers: { location: 'https://unvetted.example/sessions' } }
        );
      });
      const probe = probeLiveRuntimeSession({
        env,
        userId: 'user',
        nodeId: 'node',
        workspaceId: 'workspace',
        agentSessionId: 'session',
        vmAgentPort: 8080,
        containerFetch,
      });
      if (status === 200) await expect(probe).resolves.toBe(true);
      else await expect(probe).rejects.toThrow('runtime_session_probe_http_307');
      expect(containerFetch).toHaveBeenCalledTimes(1);
      expect(containerFetch.mock.calls[0]?.[0].headers.get('authorization')).toBe(
        'Bearer management-secret'
      );
    }
  );

  it.each([200, 307])('liveness probe reports %s directly', async (status) => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      if (status === 307 && init.redirect !== 'manual') return new Response('{}');
      return new Response('{}', {
        status,
        headers: { location: 'https://unvetted.example/health' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(probeNodeHealthForTaskLiveness(env, 'node')).resolves.toMatchObject({
      outcome: status === 200 ? 'ok' : 'failed',
      status,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
