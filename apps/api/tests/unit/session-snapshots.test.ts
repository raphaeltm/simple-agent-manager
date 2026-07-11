import { describe, expect, it } from 'vitest';

import type { Env } from '../../src/env';
import {
  buildSessionSnapshotR2Key,
  DEFAULT_SESSION_SNAPSHOT_ENTRY_THRESHOLD_BYTES,
  DEFAULT_SESSION_SNAPSHOT_R2_PREFIX,
  DEFAULT_SESSION_SNAPSHOT_TOTAL_BUDGET_BYTES,
  DEFAULT_SESSION_SNAPSHOT_TRANSFER_IDLE_TIMEOUT_MS,
  DEFAULT_SESSION_SNAPSHOT_TTL_DAYS,
  getSessionSnapshotConfig,
} from '../../src/services/session-snapshots';

function env(overrides: Partial<Env> = {}): Env {
  return overrides as Env;
}

describe('session snapshot config', () => {
  it('uses constitution-compliant defaults when env vars are absent', () => {
    const config = getSessionSnapshotConfig(env());

    expect(config).toEqual({
      ttlDays: DEFAULT_SESSION_SNAPSHOT_TTL_DAYS,
      totalBudgetBytes: DEFAULT_SESSION_SNAPSHOT_TOTAL_BUDGET_BYTES,
      entryThresholdBytes: DEFAULT_SESSION_SNAPSHOT_ENTRY_THRESHOLD_BYTES,
      transferIdleTimeoutMs: DEFAULT_SESSION_SNAPSHOT_TRANSFER_IDLE_TIMEOUT_MS,
      r2Prefix: DEFAULT_SESSION_SNAPSHOT_R2_PREFIX,
    });
  });

  it('uses positive env overrides and sanitizes the R2 prefix', () => {
    const config = getSessionSnapshotConfig(env({
      SESSION_SNAPSHOT_TTL_DAYS: '3',
      SESSION_SNAPSHOT_TOTAL_BUDGET_BYTES: '1234',
      SESSION_SNAPSHOT_ENTRY_THRESHOLD_BYTES: '567',
      SESSION_SNAPSHOT_TRANSFER_IDLE_TIMEOUT_MS: '890',
      SESSION_SNAPSHOT_R2_PREFIX: '/tenant snapshots/private/',
    }));

    expect(config.ttlDays).toBe(3);
    expect(config.totalBudgetBytes).toBe(1234);
    expect(config.entryThresholdBytes).toBe(567);
    expect(config.transferIdleTimeoutMs).toBe(890);
    expect(config.r2Prefix).toBe('tenant-snapshots/private');
  });
});

describe('session snapshot R2 keys', () => {
  it('derives deterministic one-snapshot-per-session artifact keys', () => {
    const input = env({ SESSION_SNAPSHOT_R2_PREFIX: 'snapshots' });

    expect(buildSessionSnapshotR2Key(input, 'chat/../session 1', 'home')).toBe(
      'snapshots/chat-..-session-1/home.tar'
    );
    expect(buildSessionSnapshotR2Key(input, 'chat/../session 1', 'wip')).toBe(
      'snapshots/chat-..-session-1/wip.bundle'
    );
    expect(buildSessionSnapshotR2Key(input, 'chat/../session 1', 'manifest')).toBe(
      'snapshots/chat-..-session-1/manifest.json'
    );
  });
});
