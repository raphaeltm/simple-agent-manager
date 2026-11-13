// Worker implementation of @simple-agent-manager/agent-email's ports, bound to one environment.
// Heavier modules load on first use, so a caller that only reads agent email settings does not
// pull in trigger admission and task submission.
import type { AgentEmailPorts } from '@simple-agent-manager/agent-email';

import type { Env } from '../../env';
import {
  checkRateLimit,
  createRateLimitKey,
  DEFAULT_WINDOW_SECONDS,
  getCurrentWindowStart,
} from '../../middleware/rate-limit';
import {
  CLOUDFLARE_API_BASE,
  DEFAULT_CF_API_TIMEOUT_MS,
  readCloudflareErrorDetail,
} from '../dns-core';
import { readSetting } from '../platform-config-store';
import type { TriggerTaskSubmitter } from '../trigger-admission';
import { renderTemplate } from '../trigger-template';

export interface AgentEmailPortOverrides {
  /** Replaces task submission inside trigger admission (tests). */
  submitter?: TriggerTaskSubmitter;
}

export function agentEmailPorts(
  env: Env,
  overrides: AgentEmailPortOverrides = {}
): AgentEmailPorts {
  return {
    resolveAdminSetting: async (name) =>
      (await import('../admin-settings')).resolveAdminSetting(env, name),
    readPlatformSetting: async (key) => (await readSetting(env, key)).value,
    // The window is fixed at one hour: the limits are the `agentEmail.*PerHour` settings.
    withinHourlyRateLimit: async (scope, id, limit) => {
      const key = createRateLimitKey(scope, id, getCurrentWindowStart(DEFAULT_WINDOW_SECONDS));
      return (await checkRateLimit(env.KV, key, limit, DEFAULT_WINDOW_SECONDS)).allowed;
    },
    notifyDeliveryGaveUp: async () => {
      const { notifyFailedSweeps } = await import('../../scheduled/failed-sweep-notifications');
      await notifyFailedSweeps(env, ['agent_email_delivery_gave_up']);
    },
    admitAndSubmitTrigger: async (input) => {
      const { admitAndSubmitTriggerExecution } = await import('../trigger-admission');
      return admitAndSubmitTriggerExecution(env, input, overrides.submitter);
    },
    renderTemplate,
    cloudflareApi: {
      baseUrl: CLOUDFLARE_API_BASE,
      defaultTimeoutMs: DEFAULT_CF_API_TIMEOUT_MS,
      readErrorDetail: readCloudflareErrorDetail,
    },
  };
}
