import * as v from 'valibot';
import { describe, expect, it } from 'vitest';

import { WebhookConfigValueSchema } from '../../../src/schemas/triggers';

describe('webhook trigger schema', () => {
  it('accepts deterministic scalar filters and safe header allowlists', () => {
    const parsed = v.parse(WebhookConfigValueSchema, {
      sourceLabel: 'release-system',
      filterMode: 'all',
      filters: [
        { path: 'deployment.status', operator: 'equals', value: 'failed' },
        { path: 'deployment.retryable', operator: 'exists' },
      ],
      includedHeaders: ['x-event-type', 'x-request-id'],
    });

    expect(parsed.filters).toHaveLength(2);
  });

  it.each([
    {
      name: 'prototype path',
      value: { filters: [{ path: '__proto__.polluted', operator: 'exists' }] },
    },
    {
      name: 'value on exists',
      value: { filters: [{ path: 'event', operator: 'exists', value: 'unexpected' }] },
    },
    {
      name: 'missing equality value',
      value: { filters: [{ path: 'event', operator: 'equals' }] },
    },
    {
      name: 'credential-bearing header',
      value: { includedHeaders: ['authorization'] },
    },
    {
      name: 'unknown configuration field',
      value: { filters: [], script: 'return true' },
    },
  ])('rejects $name', ({ value }) => {
    expect(v.safeParse(WebhookConfigValueSchema, value).success).toBe(false);
  });
});
