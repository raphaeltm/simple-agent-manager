import { describe, expect, it } from 'vitest';

import type { Env } from '../../../src/env';
import {
  areWebhookTriggersEnabled,
  getWebhookTriggerLimits,
  validateWebhookTriggerConfig,
} from '../../../src/services/webhook-trigger-config';

describe('webhook trigger runtime configuration', () => {
  it('defaults ingress on and honors the explicit kill switch', () => {
    expect(areWebhookTriggersEnabled({} as Env)).toBe(true);
    expect(areWebhookTriggersEnabled({ WEBHOOK_TRIGGERS_ENABLED: 'false' } as Env)).toBe(false);
    expect(areWebhookTriggersEnabled({ WEBHOOK_TRIGGERS_ENABLED: 'TRUE' } as Env)).toBe(true);
  });

  it('resolves request-time validation limits from environment settings', () => {
    const limits = getWebhookTriggerLimits({
      WEBHOOK_TRIGGER_MAX_FILTERS: '2',
      WEBHOOK_TRIGGER_MAX_FILTER_PATH_LENGTH: '12',
      WEBHOOK_TRIGGER_MAX_FILTER_PATH_DEPTH: '2',
      WEBHOOK_TRIGGER_MAX_INCLUDED_HEADERS: '1',
    } as Env);

    expect(
      validateWebhookTriggerConfig(
        {
          filters: [
            { path: 'event.action', operator: 'exists' },
            { path: 'event.kind', operator: 'equals', value: 'incident' },
          ],
          includedHeaders: ['x-event'],
        },
        limits
      )
    ).toBeNull();
    expect(
      validateWebhookTriggerConfig(
        {
          filters: [
            { path: 'event.action', operator: 'exists' },
            { path: 'event.kind', operator: 'exists' },
            { path: 'event.extra', operator: 'exists' },
          ],
        },
        limits
      )
    ).toContain('at most 2 items');
    expect(
      validateWebhookTriggerConfig({ filters: [{ path: 'a.b.c', operator: 'exists' }] }, limits)
    ).toContain('at most 2 segments');
    expect(
      validateWebhookTriggerConfig({ includedHeaders: ['x-event', 'x-request-id'] }, limits)
    ).toContain('at most 1 items');
  });
});
