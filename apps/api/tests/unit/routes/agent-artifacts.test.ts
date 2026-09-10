import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { agentRoutes } from '../../../src/routes/agent';

const RELEASE = '0123456789abcdef0123456789abcdef01234567';

function buildApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/agent', agentRoutes);
  return app;
}

function binaryObject(): R2ObjectBody {
  const bytes = new TextEncoder().encode('agent');
  return {
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    size: bytes.byteLength,
  } as unknown as R2ObjectBody;
}

function envWithR2(get: ReturnType<typeof vi.fn>, overrides: Partial<Env> = {}): Env {
  return {
    R2: { get } as unknown as R2Bucket,
    ...overrides,
  } as unknown as Env;
}

describe('VM-agent artifact routes', () => {
  it('serves the requested immutable release from its SHA-addressed key', async () => {
    const get = vi.fn().mockResolvedValue(binaryObject());
    const response = await buildApp().request(
      `/api/agent/download?os=linux&arch=amd64&release=${RELEASE}`,
      undefined,
      envWithR2(get)
    );

    expect(response.status).toBe(200);
    expect(get).toHaveBeenCalledWith(`agents/releases/${RELEASE}/vm-agent-linux-amd64`);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  });

  it('rejects malformed release identifiers before reading R2', async () => {
    const get = vi.fn();
    const response = await buildApp().request(
      '/api/agent/download?os=linux&arch=amd64&release=../../mutable',
      undefined,
      envWithR2(get)
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'INVALID_VERSION' });
    expect(get).not.toHaveBeenCalled();
  });

  it('preserves the legacy mutable route for manual and local installs', async () => {
    const get = vi.fn().mockResolvedValue(binaryObject());
    const response = await buildApp().request(
      '/api/agent/download?os=linux&arch=arm64',
      undefined,
      envWithR2(get)
    );

    expect(response.status).toBe(200);
    expect(get).toHaveBeenCalledWith('agents/vm-agent-linux-arm64');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=3600');
  });

  it('pins the install script when the deployment requires a release', async () => {
    const response = await buildApp().request(
      '/api/agent/install-script',
      { headers: { host: 'api.example.com' } },
      envWithR2(vi.fn(), { VM_AGENT_REQUIRED_VERSION: RELEASE })
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain(`&release=${RELEASE}`);
  });

  it('keeps the install script unversioned when no release is configured', async () => {
    const response = await buildApp().request(
      '/api/agent/install-script',
      { headers: { host: 'api.example.com' } },
      envWithR2(vi.fn())
    );

    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('&release=');
  });
});
