/**
 * The worker's implementation of @simple-agent-manager/agent-email's ports must call the same
 * worker services, with the same arguments, as the code it replaced inside the old
 * services/agent-email modules.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  admitAndSubmitTriggerExecution: vi.fn(),
  notifyFailedSweeps: vi.fn(),
  resolveAdminSetting: vi.fn(),
}));

vi.mock('../../../src/middleware/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/middleware/rate-limit')>()),
  checkRateLimit: mocks.checkRateLimit,
}));
vi.mock('../../../src/services/trigger-admission', () => ({
  admitAndSubmitTriggerExecution: mocks.admitAndSubmitTriggerExecution,
}));
vi.mock('../../../src/scheduled/failed-sweep-notifications', () => ({
  notifyFailedSweeps: mocks.notifyFailedSweeps,
}));
vi.mock('../../../src/services/admin-settings', () => ({
  resolveAdminSetting: mocks.resolveAdminSetting,
}));

import type { Env } from '../../../src/env';
import {
  createRateLimitKey,
  DEFAULT_WINDOW_SECONDS,
  getCurrentWindowStart,
} from '../../../src/middleware/rate-limit';
import { agentEmailPorts } from '../../../src/services/agent-email/ports';
import {
  CLOUDFLARE_API_BASE,
  DEFAULT_CF_API_TIMEOUT_MS,
  readCloudflareErrorDetail,
} from '../../../src/services/dns-core';
import { renderTemplate } from '../../../src/services/trigger-template';

function envWithSetting(row: { value: string; updatedAt: string; updatedBy: null } | null): Env {
  const first = vi.fn(async () => row);
  const bind = vi.fn(() => ({ first }));
  return {
    KV: { name: 'kv' },
    DATABASE: { prepare: vi.fn(() => ({ bind })) },
  } as unknown as Env;
}

describe('agentEmailPorts', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rate limits per scope and id over the fixed one-hour window', async () => {
    const env = envWithSetting(null);
    mocks.checkRateLimit.mockResolvedValueOnce({ allowed: false });

    const allowed = await agentEmailPorts(env).withinHourlyRateLimit(
      'agent-email-inbound',
      't1',
      7
    );

    expect(allowed).toBe(false);
    expect(DEFAULT_WINDOW_SECONDS).toBe(3600);
    expect(mocks.checkRateLimit).toHaveBeenCalledWith(
      env.KV,
      createRateLimitKey(
        'agent-email-inbound',
        't1',
        getCurrentWindowStart(DEFAULT_WINDOW_SECONDS)
      ),
      7,
      DEFAULT_WINDOW_SECONDS
    );
  });

  it('admits through the shared trigger path, with the default submitter unless overridden', async () => {
    const env = envWithSetting(null);
    const input = { executionId: 'e1' } as never;
    mocks.admitAndSubmitTriggerExecution.mockResolvedValue({
      outcome: 'inactive',
      reason: 'paused',
    });

    await expect(agentEmailPorts(env).admitAndSubmitTrigger(input)).resolves.toEqual({
      outcome: 'inactive',
      reason: 'paused',
    });
    // Undefined lets admitAndSubmitTriggerExecution apply its own default (submitTriggeredTask).
    expect(mocks.admitAndSubmitTriggerExecution).toHaveBeenLastCalledWith(env, input, undefined);

    const submitter = vi.fn();
    await agentEmailPorts(env, { submitter }).admitAndSubmitTrigger(input);
    expect(mocks.admitAndSubmitTriggerExecution).toHaveBeenLastCalledWith(env, input, submitter);
  });

  it('reads the stored platform setting value, or null when unset', async () => {
    await expect(
      agentEmailPorts(envWithSetting(null)).readPlatformSetting('k')
    ).resolves.toBeNull();
    const stored = envWithSetting({
      value: '{"domain":"agents.x"}',
      updatedAt: 't',
      updatedBy: null,
    });
    await expect(agentEmailPorts(stored).readPlatformSetting('k')).resolves.toBe(
      '{"domain":"agents.x"}'
    );
  });

  it('alerts the gave-up sweep and resolves admin settings with the worker env', async () => {
    const env = envWithSetting(null);
    mocks.resolveAdminSetting.mockResolvedValueOnce(42);

    await agentEmailPorts(env).notifyDeliveryGaveUp();
    expect(mocks.notifyFailedSweeps).toHaveBeenCalledWith(env, ['agent_email_delivery_gave_up']);
    await expect(agentEmailPorts(env).resolveAdminSetting('agentEmail.maxBodyChars')).resolves.toBe(
      42
    );
    expect(mocks.resolveAdminSetting).toHaveBeenCalledWith(env, 'agentEmail.maxBodyChars');
  });

  it('passes the shared template renderer and Cloudflare API helpers through unchanged', () => {
    const ports = agentEmailPorts(envWithSetting(null));
    expect(ports.renderTemplate).toBe(renderTemplate);
    expect(ports.cloudflareApi).toEqual({
      baseUrl: CLOUDFLARE_API_BASE,
      defaultTimeoutMs: DEFAULT_CF_API_TIMEOUT_MS,
      readErrorDetail: readCloudflareErrorDetail,
    });
  });
});
