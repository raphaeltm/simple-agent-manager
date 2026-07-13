import { describe, expect, it } from 'vitest';

import {
  fingerprintWebhookRequest,
  generateWebhookToken,
  getWebhookTokenLastFour,
  hashWebhookIdempotencyKey,
  hashWebhookToken,
  hasWebhookTokenPrefix,
} from '../../../src/services/webhook-trigger-crypto';

describe('webhook trigger credentials', () => {
  it('generates unique prefixed 256-bit bearer tokens', () => {
    const first = generateWebhookToken();
    const second = generateWebhookToken();
    expect(first).toMatch(/^sam_wh_[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
    expect(hasWebhookTokenPrefix(first)).toBe(true);
    expect(getWebhookTokenLastFour(first)).toBe(first.slice(-4));
  });

  it('uses deterministic, secret-keyed, domain-separated hashes', async () => {
    const token = 'sam_wh_example';
    const tokenHash = await hashWebhookToken(token, 'secret-a');
    expect(await hashWebhookToken(token, 'secret-a')).toBe(tokenHash);
    expect(await hashWebhookToken(token, 'secret-b')).not.toBe(tokenHash);
    expect(await hashWebhookIdempotencyKey(token, 'secret-a')).not.toBe(tokenHash);
    expect(await fingerprintWebhookRequest(token, 'secret-a')).not.toBe(tokenHash);
    expect(tokenHash).not.toContain(token);
  });
});
