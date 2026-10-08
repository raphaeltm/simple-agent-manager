import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { log } from '../../../src/lib/logger';
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

  // Production 2026-10-08: every Claude callback returned 400 here because the
  // echoed credential reference (a backfilled `cc_credentials:cred-{owner}-{ciphertext}:{iv}`,
  // 238 chars) exceeded the 160-char identifier bound. Codex's 49-char reference passed.
  it('accepts the long credential reference a backfilled credential carries', async () => {
    const credentialReference =
      'cc_credentials:cred-4bw1FXkQ7cK2nY8pR3sT6uV9wZ0aB1cD-' +
      'KgCluaQx9+Ga5+i+JTSMVBxORYB/j3L90fcFFZrC4rik9mbQ2'.repeat(3) +
      '/msAieB+gfJsvMulc0mQ==:MPQAR5bNpdU+BnN0';
    const response = await usageRequest(
      {
        nodeId: 'node-1',
        agentType: 'claude-code',
        credentialReference,
        credentialSource: 'user',
        credentialGeneration: 1,
        observedAt: 1_791_496_287_022,
        source: 'claude-acp.usage_update',
        rateLimits: [
          {
            windowType: 'claude.five_hour',
            provider: 'anthropic',
            source: 'claude-acp.rate_limit',
            status: 'allowed',
            utilizationPercent: 13,
            windowMinutes: 300,
            resetsAt: 1_791_507_194_000,
            observedAt: 1_791_496_287_022,
            freshnessMs: 0,
          },
          {
            windowType: 'claude.seven_day',
            provider: 'anthropic',
            source: 'claude-acp.rate_limit',
            status: 'allowed',
            utilizationPercent: 31,
            windowMinutes: 10080,
            resetsAt: 1_791_841_994_000,
            observedAt: 1_791_496_287_022,
            freshnessMs: 0,
          },
        ],
      },
      { CREDENTIAL_LIMIT_USAGE_CALLBACK_MAX_BODY_BYTES: '4096' }
    );

    expect(credentialReference.length).toBeGreaterThan(160);
    expect(response.status).toBe(204);
    expect(handleAcpUsageCallback).toHaveBeenCalledTimes(1);
    expect(vi.mocked(handleAcpUsageCallback).mock.calls[0]![1].body.credentialReference).toBe(
      credentialReference
    );
  });

  it('keeps the identifier bound on window types and logs the failing field, not its value', async () => {
    const warn = vi.spyOn(log, 'warn');
    try {
      const response = await usageRequest(
        {
          nodeId: 'node-1',
          rateLimits: [{ windowType: `claude.${'x'.repeat(160)}`, status: 'allowed' }],
        },
        { CREDENTIAL_LIMIT_USAGE_CALLBACK_MAX_BODY_BYTES: '4096' }
      );

      expect(response.status).toBe(400);
      expect(handleAcpUsageCallback).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith('acp_usage.invalid_callback_body', {
        projectId: 'project-1',
        sessionId: 'session-1',
        invalidFields: ['rateLimits.[].windowType'],
        action: 'rejected',
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('xxxxxxxx');
    } finally {
      warn.mockRestore();
    }
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
