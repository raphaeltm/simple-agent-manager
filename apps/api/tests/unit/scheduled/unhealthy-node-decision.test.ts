import { describe, expect, it } from 'vitest';

import type { Env } from '../../../src/env';
import { resolveCleanupConfig } from '../../../src/scheduled/node-cleanup/shared';
import { decideUnhealthyNode } from '../../../src/scheduled/node-cleanup/unhealthy-nodes';

const now = Date.parse('2026-09-25T12:00:00.000Z');
const config = resolveCleanupConfig({} as Env);

function node(lastContactMsAgo: number) {
  const lastHeartbeatAt = new Date(now - lastContactMsAgo).toISOString();
  return {
    created_at: new Date(now - 60 * 60 * 1000).toISOString(),
    last_heartbeat_at: lastHeartbeatAt,
    heartbeat_stale_after_seconds: 180,
  };
}

describe('unhealthy node decision', () => {
  it('leaves a healthy node untouched and allows recovery inside the drain window', () => {
    expect(decideUnhealthyNode(node(60_000), now, config)).toBe('healthy');
    expect(decideUnhealthyNode(node(7 * 60_000), now, config)).toBe('waiting');
  });

  it('drains then releases after the configured heartbeat-loss bound', () => {
    expect(decideUnhealthyNode(node(config.unhealthyDrainAfterMs + 1), now, config)).toBe('drain');
    expect(decideUnhealthyNode(node(config.unhealthyReleaseAfterMs), now, config)).toBe('release');
  });

  it('uses configured thresholds through the production resolver', () => {
    const custom = resolveCleanupConfig({
      NODE_UNHEALTHY_DRAIN_AFTER_MS: '120000',
      NODE_UNHEALTHY_RELEASE_AFTER_MS: '600000',
    } as Env);
    expect(decideUnhealthyNode(node(7 * 60_000), now, custom)).toBe('drain');
    expect(decideUnhealthyNode(node(10 * 60_000), now, custom)).toBe('release');
  });
});
