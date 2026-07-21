import { describe, expect, it } from 'vitest';

import {
  parsePositiveRuntimeSetting,
  resolveRuntimeSettings,
} from '../../../src/durable-objects/vm-agent-container-runtime';
import type { Env } from '../../../src/env';

const DEFAULTS = {
  portReadyTimeoutMs: 30_000,
  activeWorkMaxMs: 2 * 60 * 60 * 1000,
  keepaliveRenewIntervalMs: 5 * 60 * 1000,
  recoveryMaxAttempts: 2,
};

function envWith(overrides: Record<string, string | undefined> = {}): Env {
  return overrides as unknown as Env;
}

describe('parsePositiveRuntimeSetting', () => {
  it('returns the fallback when unset', () => {
    expect(parsePositiveRuntimeSetting(undefined, 42)).toBe(42);
  });

  it('honors a valid positive override', () => {
    expect(parsePositiveRuntimeSetting('7', 42)).toBe(7);
  });

  it.each([
    ['zero', '0'],
    ['negative', '-3'],
    ['non-numeric', 'banana'],
    ['empty string', ''],
  ])('falls back on invalid input (%s)', (_label, raw) => {
    expect(parsePositiveRuntimeSetting(raw, 42)).toBe(42);
  });
});

describe('resolveRuntimeSettings', () => {
  it('uses provided defaults when no env overrides are set', () => {
    expect(resolveRuntimeSettings(envWith(), DEFAULTS)).toEqual(DEFAULTS);
  });

  it('honors each env override independently', () => {
    const settings = resolveRuntimeSettings(
      envWith({
        CF_CONTAINER_PORT_READY_TIMEOUT_MS: '1000',
        CF_CONTAINER_ACTIVE_WORK_MAX_MS: '2000',
        CF_CONTAINER_KEEPALIVE_RENEW_INTERVAL_MS: '3000',
        CF_CONTAINER_RECOVERY_MAX_ATTEMPTS: '4',
      }),
      DEFAULTS
    );
    expect(settings).toEqual({
      portReadyTimeoutMs: 1000,
      activeWorkMaxMs: 2000,
      keepaliveRenewIntervalMs: 3000,
      recoveryMaxAttempts: 4,
    });
  });

  it('falls back per-setting when an override is invalid', () => {
    const settings = resolveRuntimeSettings(
      envWith({
        CF_CONTAINER_RECOVERY_MAX_ATTEMPTS: '0',
        CF_CONTAINER_ACTIVE_WORK_MAX_MS: 'not-a-number',
      }),
      DEFAULTS
    );
    expect(settings.recoveryMaxAttempts).toBe(DEFAULTS.recoveryMaxAttempts);
    expect(settings.activeWorkMaxMs).toBe(DEFAULTS.activeWorkMaxMs);
  });
});
