import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { agentUsageCallbackRoute } from '../../../src/routes/projects/agent-usage-callback';
import { handleAcpUsageCallback } from '../../../src/services/acp-usage-callback-handler';

vi.mock('../../../src/services/acp-usage-callback-handler', () => ({
  handleAcpUsageCallback: vi.fn(async (c) => c.body(null, 204)),
}));

const app = new Hono<{ Bindings: Env }>();
app.route('/api/projects', agentUsageCallbackRoute);

function usageRequest(body: unknown, env: Partial<Env> = {}) {
  return app.request(
    '/api/projects/project-1/acp-sessions/session-1/usage',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer callback-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    {
      CREDENTIAL_LIMIT_USAGE_CALLBACK_MAX_BODY_BYTES: '256',
      ...env,
    } as Env
  );
}

describe('agent usage callback route', () => {
  beforeEach(() => {
    vi.mocked(handleAcpUsageCallback).mockClear();
  });

  it('rejects oversized callback bodies before service handling', async () => {
    const response = await usageRequest(
      {
        nodeId: 'node-1',
        rateLimits: [
          {
            windowType: 'claude.five_hour',
            status: 'allowed_warning',
            utilizationPercent: 82,
            diagnostic: 'x'.repeat(512),
          },
        ],
      },
      { CREDENTIAL_LIMIT_USAGE_CALLBACK_MAX_BODY_BYTES: '128' }
    );

    expect(response.status).toBe(413);
    expect(handleAcpUsageCallback).not.toHaveBeenCalled();
  });

  it('rejects batches over the callback observation cap', async () => {
    const response = await usageRequest(
      {
        nodeId: 'node-1',
        rateLimits: Array.from({ length: 17 }, () => ({
          windowType: 'claude.five_hour',
          status: 'allowed_warning',
        })),
      },
      { CREDENTIAL_LIMIT_USAGE_CALLBACK_MAX_BODY_BYTES: '4096' }
    );

    expect(response.status).toBe(400);
    expect(handleAcpUsageCallback).not.toHaveBeenCalled();
  });
});
