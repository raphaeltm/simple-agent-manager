/**
 * Config parsing and threshold-ordering guards for the cleanup sweep.
 *
 * These parsers sit in front of every destroy threshold in the sweep, so a regression
 * here silently changes how aggressively SAM destroys infrastructure. They are tested
 * directly rather than only through phase behaviour, where a broken fallback would be
 * masked by whatever the phase happened to do with the bad value.
 */
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import {
  parseMs,
  parsePositiveInt,
  resolveCleanupConfig,
} from '../../../src/scheduled/node-cleanup/shared';

const logWarn = vi.fn();

vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), warn: (...a: unknown[]) => logWarn(...a), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../src/services/node-agent', () => ({
  getNodeAgentBackgroundRequestTimeoutMs: vi.fn().mockReturnValue(5_000),
  deleteWorkspaceOnNode: vi.fn(),
  stopWorkspaceOnNode: vi.fn(),
}));
vi.mock('../../../src/services/nodes', () => ({ deleteNodeResourcesStrict: vi.fn() }));
vi.mock('../../../src/services/observability', () => ({ persistError: vi.fn() }));

describe('parseMs', () => {
  it('returns the parsed value for valid positive input', () => {
    expect(parseMs('60000', 999)).toBe(60_000);
  });

  it.each([
    ['undefined', undefined],
    ['empty string', ''],
    ['whitespace', '   '],
    ['non-numeric', 'abc'],
    ['negative', '-100'],
    ['zero', '0'],
    ['Infinity', 'Infinity'],
    ['NaN', 'NaN'],
  ])('falls back to the default for %s', (_label, value) => {
    // Falling back rather than throwing matters: a bad env value must never make the
    // sweep destroy on a nonsense threshold, and must never abort the cron either.
    expect(parseMs(value as string | undefined, 4242)).toBe(4242);
  });

  it('tolerates trailing garbage the way parseInt does', () => {
    expect(parseMs('5000ms', 999)).toBe(5_000);
  });
});

describe('parsePositiveInt', () => {
  it('returns the parsed value for valid positive input', () => {
    expect(parsePositiveInt('25', 999)).toBe(25);
  });

  it.each([
    ['undefined', undefined],
    ['empty string', ''],
    ['non-numeric', 'abc'],
    ['negative', '-1'],
    ['zero', '0'],
  ])('falls back to the default for %s', (_label, value) => {
    expect(parsePositiveInt(value as string | undefined, 7)).toBe(7);
  });
});

describe('resolveCleanupConfig threshold ordering', () => {
  it('does not warn on the shipped defaults', () => {
    logWarn.mockClear();
    resolveCleanupConfig({} as Env);

    expect(logWarn).not.toHaveBeenCalledWith(
      'node_cleanup.threshold_ordering_inverted',
      expect.anything()
    );
  });

  it('warns when the idle window drops below the warm timeout', () => {
    // Reaping sooner than the warm window would destroy nodes the pool intends to
    // reuse. It still sweeps — a warning, not a hard failure — but it must be visible.
    logWarn.mockClear();
    resolveCleanupConfig({
      NODE_ORPHAN_IDLE_TIMEOUT_MS: String(60_000),
      NODE_WARM_TIMEOUT_MS: String(30 * 60_000),
    } as Env);

    expect(logWarn).toHaveBeenCalledWith(
      'node_cleanup.threshold_ordering_inverted',
      expect.objectContaining({
        problems: expect.arrayContaining([expect.stringContaining('NODE_ORPHAN_IDLE_TIMEOUT_MS')]),
      })
    );
  });

  it('warns when the absolute ceiling drops below the max lifetime', () => {
    // This inversion makes the absolute-ceiling branch trivially true for every
    // max-lifetime candidate — silently converting the backstop into the primary rule.
    logWarn.mockClear();
    resolveCleanupConfig({
      NODE_ABSOLUTE_MAX_LIFETIME_MS: String(60 * 60_000),
      MAX_AUTO_NODE_LIFETIME_MS: String(4 * 60 * 60_000),
    } as Env);

    expect(logWarn).toHaveBeenCalledWith(
      'node_cleanup.threshold_ordering_inverted',
      expect.objectContaining({
        problems: expect.arrayContaining([
          expect.stringContaining('NODE_ABSOLUTE_MAX_LIFETIME_MS'),
        ]),
      })
    );
  });

  it('still returns a usable config when thresholds are inverted', () => {
    // Degraded precision beats not sweeping at all.
    const config = resolveCleanupConfig({
      NODE_ORPHAN_IDLE_TIMEOUT_MS: String(60_000),
    } as Env);

    expect(config.orphanIdleTimeoutMs).toBe(60_000);
    expect(config.nodeSweepLimit).toBeGreaterThan(0);
  });

  it('falls back to defaults for every invalid override', () => {
    const config = resolveCleanupConfig({
      NODE_ORPHAN_IDLE_TIMEOUT_MS: 'not-a-number',
      NODE_ABSOLUTE_MAX_LIFETIME_MS: '-5',
      NODE_CLEANUP_SWEEP_LIMIT: '0',
      WORKSPACE_CLEANUP_SWEEP_LIMIT: 'abc',
    } as Env);

    expect(config.orphanIdleTimeoutMs).toBe(45 * 60_000);
    expect(config.absoluteMaxLifetimeMs).toBe(24 * 60 * 60_000);
    expect(config.nodeSweepLimit).toBe(25);
    expect(config.workspaceSweepLimit).toBe(50);
  });
});
