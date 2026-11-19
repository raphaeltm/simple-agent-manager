import { describe, expect, it } from 'vitest';

import { redactForkHistory } from '../../../src/services/archived-chat-fork';

describe('archived Fork historical secret redaction', () => {
  it('redacts labelled assignments while retaining ordinary historical data', () => {
    const history =
      'normal=value auth_token="CANARY token" api-key=CANARY_KEY password:\'CANARY_PASSWORD\' nested.cookie=CANARY_COOKIE';
    const redacted = redactForkHistory(history);
    expect(redacted).toContain('normal=value');
    expect(redacted).toContain('auth_token=[REDACTED]');
    expect(redacted).toContain('api-key=[REDACTED]');
    expect(redacted).toContain('password:[REDACTED]');
    expect(redacted).toContain('nested.cookie=[REDACTED]');
    expect(redacted).not.toContain('CANARY');
  });

  it('finds secret assignments inside benign quoted and JSON values', () => {
    const history = `note="password=CANARY_PASSWORD" {"note":"token=CANARY_TOKEN"} message='nested.api-key=CANARY_KEY'`;
    const redacted = redactForkHistory(history);
    expect(redacted).not.toContain('CANARY');
    expect(redacted).toContain('password=[REDACTED]');
    expect(redacted).toContain('token=[REDACTED]');
    expect(redacted).toContain('nested.api-key=[REDACTED]');
  });

  it('bounds matching work on long labels with no assignment delimiter', () => {
    const history = `${'a.'.repeat(50_000)} token_without_delimiter ${' '.repeat(100_000)}\nsecret=CANARY_SECRET`;
    const started = performance.now();
    const redacted = redactForkHistory(history);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(redacted.startsWith('a.'.repeat(50_000))).toBe(true);
    expect(redacted).toContain('secret=[REDACTED]');
    expect(redacted).not.toContain('CANARY_SECRET');
  });
});
