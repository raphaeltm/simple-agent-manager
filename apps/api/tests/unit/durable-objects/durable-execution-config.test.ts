import { describe, expect, it } from 'vitest';

import {
  promptDeliveryBackoffMs,
  resolveDurableExecutionConfig,
} from '../../../src/durable-objects/project-data/durable-execution-config';

describe('durable execution configuration', () => {
  it('enables durable delivery by default while optional supervisor paths stay off', () => {
    const config = resolveDurableExecutionConfig({});
    expect(config.deliveryEnabled).toBe(true);
    expect(config.legacyVmCompatEnabled).toBe(false);
    expect(config.supervisorEnabled).toBe(false);
    expect(config.checkpointThresholdMs).toBe(5 * 60 * 60 * 1000);
  });

  it('rejects malformed booleans and unsafe timing relationships', () => {
    expect(() =>
      resolveDurableExecutionConfig({
        DURABLE_PROMPT_DELIVERY_ENABLED: 'yes',
      })
    ).toThrow('Expected boolean');
    expect(() =>
      resolveDurableExecutionConfig({
        PROMPT_DELIVERY_RETRY_BASE_MS: '10000',
        PROMPT_DELIVERY_RETRY_MAX_MS: '5000',
      })
    ).toThrow('RETRY_BASE_MS must be <=');
    expect(() =>
      resolveDurableExecutionConfig({
        PROMPT_DELIVERY_RECEIPT_TIMEOUT_MS: '60000',
        PROMPT_DELIVERY_TTL_MS: '60000',
      })
    ).toThrow('RECEIPT_TIMEOUT_MS must be <');
  });

  it('bounds exponential retry delays', () => {
    const retryConfig = { retryBaseMs: 5_000, retryMaxMs: 20_000 };
    expect(promptDeliveryBackoffMs(1, retryConfig)).toBe(5_000);
    expect(promptDeliveryBackoffMs(2, retryConfig)).toBe(10_000);
    expect(promptDeliveryBackoffMs(10, retryConfig)).toBe(20_000);
  });
});
