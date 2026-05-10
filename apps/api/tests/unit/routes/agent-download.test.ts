import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../../src/env';
import { agentRoutes } from '../../../src/routes/agent';

function createApp(r2Object: R2ObjectBody | null) {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/agent', agentRoutes);

  const env = {
    R2: {
      get: async (key: string) => {
        if (!r2Object) return null;
        return key === 'agents/sam-harness-linux-amd64' ? r2Object : null;
      },
    },
  } as unknown as Env;

  return { app, env };
}

function createR2Object(body: string): R2ObjectBody {
  return {
    body: new Response(body).body,
    size: body.length,
  } as R2ObjectBody;
}

describe('GET /api/agent/download', () => {
  it('downloads sam-harness linux amd64 binary from R2', async () => {
    const { app, env } = createApp(createR2Object('harness-binary'));

    const res = await app.request(
      '/api/agent/download?agent=sam-harness&os=linux&arch=amd64',
      {},
      env,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toContain('sam-harness-linux-amd64');
    expect(await res.text()).toBe('harness-binary');
  });

  it('rejects unsupported sam-harness platforms', async () => {
    const { app, env } = createApp(createR2Object('harness-binary'));

    const res = await app.request(
      '/api/agent/download?agent=sam-harness&os=darwin&arch=amd64',
      {},
      env,
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'INVALID_PLATFORM' });
  });
});
